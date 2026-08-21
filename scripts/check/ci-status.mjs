// HYK-334-ci-status-1 (coder-task.md) -- CI 상태 조회 정본.
//
// 배경: ORCH가 PR 발행 뒤 `gh pr checks <번호>`로 CI를 감시했는데, 이 좌석의
// `gh`는 인증돼 있지 않다. 문제는 실패 "방식"이다 -- `gh`가 오류로 죽지
// 않고 빈 값을 준다. 감시기는 그걸 "아직 결과가 안 나왔다"(PENDING)로 읽고
// 조용히 계속 기다렸다 -- CI가 이미 GREEN인데도 영원히 "대기 중"이었다.
// 핵심 교훈: "신호 없음 = 아직 안 끝남"으로 해석하면 도구 고장과 구분이
// 안 된다. 이 모듈은 그 혼동을 구조적으로 막는다 -- ⛔UNKNOWN을 PENDING으로
// 흡수하지 않는다.
//
// 기본 경로 = GitHub 공개 REST API(무인증 읽기, https://api.github.com).
// ⛔토큰을 쓰지 않는다 -- 공개 저장소라 필요 없고, 자격증명 경계가
// 좁아지는 것이 이 수리의 부수 이득이다(coder-task.md §3-1). 코드
// 전체에 토큰 관련 참조가 0개인 것은 3-4-6의 시험이 고정한다.
//
// 판정 코어(classifyCiStatus)는 순수 함수다 -- 네트워크·시간·환경 의존
// 0. dispatch-gate-decision-core.mjs/orca-posture-check.mjs의 코어/어댑터
// 관례를 따른다: 코어는 이미 파싱된 값만 받고, 어댑터(fetchCheckRuns/
// pollCiStatus)가 실제 fetch를 수행해 코어에 구조화된 값을 넘긴다.

// ---- 코어: 순수 판정 함수 --------------------------------------------------

// 판정은 닫힌 4갈래(coder-task.md §3-2) -- 이 밖은 없다.
export const CI_VERDICT = Object.freeze({
  GREEN: "GREEN",
  RED: "RED",
  PENDING: "PENDING",
  UNKNOWN: "UNKNOWN",
});

// 종료코드(네가 정하고 문서화하라는 지시대로 이 표가 유일한 정의):
//   GREEN=0 · RED=1 · PENDING=2 · UNKNOWN=3
export const CI_EXIT_CODE = Object.freeze({
  [CI_VERDICT.GREEN]: 0,
  [CI_VERDICT.RED]: 1,
  [CI_VERDICT.PENDING]: 2,
  [CI_VERDICT.UNKNOWN]: 3,
});

// 3R(coder-task.md 3R §2⑴) -- 도그푸딩(ORCH가 이 도구로 이 PR 자신의 CI를
// 확인)이 찾은 한계 수리: 403이면서 X-RateLimit-Remaining:0인 경우를
// "그냥 확인 불가"와 구별한다. ★설계 선택(두 방향 중 ⓐ 채택, 이유를 여기
// 적는다): 상태값은 여전히 UNKNOWN(종료코드 3 그대로) -- 새 상태값/새
// 종료코드(ⓑ)를 만들지 않았다. 이유: (1) 한도 소진도 "이 조회로는 확인
// 불가"라는 사실 자체는 다른 UNKNOWN 사유들과 같다 -- CI_EXIT_CODE 계약
// (호출자가 "3=확인 불가, 재시도하거나 사람이 봐라"로 이미 알고 있는 계약)을
// 안 깨는 게 새 종료코드를 배우게 하는 것보다 싸다. (2) ⛔PENDING 흡수
// 금지(1R 반려의 재발 방지)는 상태값을 안 바꿔도 그대로 지켜진다 -- 여전히
// UNKNOWN 하나의 갈래 안에 있다. 대신 **사유를 기계가 구별**할 수 있게
// `reasonCode`를 추가한다(사람은 `reason` 문자열의 재시도 시각으로,
// 프로그램은 `reasonCode === CI_REASON_CODE.RATE_LIMIT_EXHAUSTED`로 구별).
// ⛔"그냥 403"(한도와 무관한 접근 거부 등)은 reasonCode 없이 기존과 동일한
// 일반 UNKNOWN으로 남는다 -- 둘을 뭉치면 이 라운드가 무의미하다는 지시를
// 그대로 지킨다.
export const CI_REASON_CODE = Object.freeze({
  RATE_LIMIT_EXHAUSTED: "RATE_LIMIT_EXHAUSTED",
});

// total_count: 0(체크가 하나도 안 붙음)의 처리 -- coder-task.md §3-2
// 요구대로 명시적으로 정한다: **UNKNOWN**으로 판정한다(PENDING이 아니다).
// 이유: "check가 아직 안 붙었다"(워크플로 트리거 지연)와 "커밋 자체가
// 잘못됐거나 워크플로가 이 저장소에 아예 없다"(운영 오류)를 total_count:0
// 하나만으로는 구분할 수 없다 -- 후자를 PENDING으로 흡수하면 무한 대기가
// 재발한다(이 이슈의 원인 그 자체). UNKNOWN으로 fail-loud하면 호출자가
// 최소한 "왜 0개인지" 직접 확인하게 된다. ⛔조용히 GREEN으로 떨어지는
// 경로는 없다(거짓 통과 방지, §3-2 요구).
// 2R P1-1 수리(검토 1R 반려): "완료" 판정(status !== "completed")이 아니라
// "아직" 판정도 명시 허용 목록이어야 한다 -- 이전 구현은 status가 문자열이기만
// 하면(타입 검사만) "completed"가 아닌 모든 값(예: "mystery")을 그대로
// PENDING으로 흘려보냈다. 그게 이 이슈의 본질(확인 불가를 아직으로 뭉개지
// 마라)을 정확히 어겼다(coder-task.md 2R §1).
//
// 허용 목록 근거: GitHub REST API 공식 문서(2026-08-21 WebFetch로 직접 확인,
// https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28 -- "List
// check runs for a Git reference"/"Get a check run" 두 엔드포인트가 공통으로
// 문서화한 check run의 status 필드) -- 이 API가 실제로 쓰는 status 값은
// 정확히 이 6개뿐이다: queued · in_progress · completed · waiting ·
// requested · pending. 추측으로 넣은 값은 0개 -- completed를 뺀 나머지
// 5개(queued/in_progress/waiting/requested/pending) 전부가 "아직"을 뜻하는
// 공식 문서 값이므로 전부 허용 목록에 넣었다(coder-task.md 2R §2-1이 최소
// queued·in_progress 요구 + waiting/requested/pending 계열 존재 확인을
// 요구했고, 셋 다 공식 문서에 있어 그대로 반영).
//
// ⛔이 하네스의 원칙(모르면 UNKNOWN, 좁게 잡는다)과 "허용 목록이 좁으면
// 정상 CI가 UNKNOWN으로 뜬다"는 위험의 균형: 문서에 없는 값(예: 미래에
// GitHub가 새 status를 추가하거나, 오타/스키마 드리프트로 다른 문자열이
// 온 경우)은 전부 UNKNOWN으로 보낸다 -- "실제로 쓰이는 문서화된 값"만
// PENDING으로 인정하고, 그 밖은 전부 확인 불가로 fail-loud한다. 정직
// 한계: GitHub가 이 필드에 새 enum 값을 추가하면(문서 갱신 없이 조용히
// 배포될 수도 있음) 그 값도 이 목록엔 없어 UNKNOWN이 뜬다 -- 그게 이
// 원칙의 의도된 대가다(모르는 값 = 확인 불가, 조용한 PENDING 흡수보다
// 낫다).
const KNOWN_PENDING_STATUSES = Object.freeze([
  "queued",
  "in_progress",
  "waiting",
  "requested",
  "pending",
]);

// ESLint complexity(<=12) 예산 때문에 하위 판정을 별 함수로 쪼갠다
// (orca-posture-check.mjs의 tokensDirVerdict/workspacesFileVerdict 선례와
// 동일한 이유).
function isMalformedCheckRun(run) {
  const statusOk =
    typeof run?.status === "string" &&
    (run.status === "completed" || KNOWN_PENDING_STATUSES.includes(run.status));
  const conclusionOk =
    run?.conclusion === undefined ||
    run?.conclusion === null ||
    typeof run.conclusion === "string";
  return !statusOk || !conclusionOk;
}

function findMalformedCheckRun(checkRuns) {
  return checkRuns.find(isMalformedCheckRun);
}

function classifyFromCheckRuns(checkRuns) {
  if (!Array.isArray(checkRuns)) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: "check_runs가 배열이 아님 -- 예상 필드 부재",
    };
  }
  if (checkRuns.length === 0) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason:
        "total_count=0(체크가 하나도 안 붙음) -- PENDING이 아니라 UNKNOWN: 워크플로 미등록/커밋 오배선과 '아직 안 붙음'을 구분할 수 없다",
    };
  }
  const malformed = findMalformedCheckRun(checkRuns);
  if (malformed) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: `check_runs 항목의 status/conclusion 필드 형식이 예상과 다름 (name=${malformed?.name ?? "?"})`,
    };
  }
  const notCompleted = checkRuns.filter((r) => r.status !== "completed");
  if (notCompleted.length > 0) {
    return {
      verdict: CI_VERDICT.PENDING,
      reason: `${notCompleted.length}/${checkRuns.length}개 check가 아직 completed 아님 (예: ${notCompleted[0].name ?? "?"}=${notCompleted[0].status})`,
    };
  }
  const failed = checkRuns.filter((r) => r.conclusion !== "success");
  if (failed.length > 0) {
    return {
      verdict: CI_VERDICT.RED,
      reason: `${failed.length}/${checkRuns.length}개 check가 success 아님 (예: ${failed[0].name ?? "?"}=${failed[0].conclusion})`,
    };
  }
  return {
    verdict: CI_VERDICT.GREEN,
    reason: `${checkRuns.length}개 check 전부 completed+success`,
  };
}

// classifyCiStatus -- 이 모듈의 유일한 판정 진입점(순수 함수).
// 입력: { httpOk, status, body } -- 어댑터가 이미 시도한 fetch+JSON.parse의
// 결과를 그대로 구조화해 넘긴다. 이 함수 자신은 네트워크를 만지지 않는다.
//   httpOk: boolean|null -- fetch 자체가 실패했으면 null
//   status: number|null -- HTTP status code (fetch 실패 시 null)
//   body: string|null -- 원문 응답 텍스트(파싱 실패 재현용, 성공 시 무시 가능)
//   parsed: unknown -- JSON.parse(body) 결과 또는 파싱 실패 시 undefined
//   parseError: boolean -- JSON.parse가 던졌으면 true
// KST(Asia/Seoul) HH:MM:SS 변환 -- 순수 함수(입력 epoch초 하나에만
// 의존, Date.now()/시스템 타임존 설정 어느 쪽도 읽지 않는다: Intl의
// timeZone 옵션이 호스트 타임존과 무관하게 고정 변환을 보장하므로 시험이
// 고정 값으로 검증 가능하다(coder-task.md 3R §2⑴/§3 요구). 실측:
// epoch=1787294363(도그푸딩 실측값) -> "15:39:23", 이슈 원문의 "2026-08-21
// 15:39:23 KST"와 일치 확인.
function formatKstRetryTime(resetEpochSeconds) {
  const date = new Date(resetEpochSeconds * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return fmt.format(date);
}

// 403 + X-RateLimit-Remaining/Reset 헤더 원문(문자열|null)을 받아
// "한도 소진인지"를 판정하는 순수 함수. ⛔안전측 기본값 = "한도 소진
// 아님"(coder-task.md 3R §2⑸/시험4 요구) -- 두 헤더 다 정확히 파싱되고
// remaining이 "0"일 때만 exhausted:true. 헤더가 없거나(구버전 응답 흉내)
// 숫자가 아니거나(스키마 드리프트) reset이 깨져 있으면(재시도 시각을 못
// 만듦) 전부 "한도 소진 아님"으로 떨어진다 -- 조용히 한도 소진으로
// 오판정하는 경로가 없다.
const DIGITS_ONLY_RE = /^\d+$/;

function parseRateLimitInfo(remainingRaw, resetRaw) {
  const remainingOk =
    typeof remainingRaw === "string" && DIGITS_ONLY_RE.test(remainingRaw);
  const resetOk = typeof resetRaw === "string" && DIGITS_ONLY_RE.test(resetRaw);
  if (!remainingOk || !resetOk || Number(remainingRaw) !== 0) {
    return { exhausted: false };
  }
  return { exhausted: true, retryAtKst: formatKstRetryTime(Number(resetRaw)) };
}

function classify403({ rateLimitRemaining, rateLimitReset }) {
  const rateLimit = parseRateLimitInfo(rateLimitRemaining, rateLimitReset);
  if (rateLimit.exhausted) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reasonCode: CI_REASON_CODE.RATE_LIMIT_EXHAUSTED,
      reason: `HTTP 403 -- 무인증 호출 한도 소진(X-RateLimit-Remaining:0) -- ${rateLimit.retryAtKst} 이후 재시도(확인 불가, 일시적)`,
    };
  }
  return {
    verdict: CI_VERDICT.UNKNOWN,
    reason: "HTTP 403 -- 접근 거부(한도 소진 아님) -- 확인 불가",
  };
}

// ESLint complexity(<=12) 예산 때문에 전송 계층 실패(네트워크/파싱/HTTP)의
// 판정을 별 함수로 쪼갠다. null을 돌려주면 "전송 계층은 통과, 본문 판정으로
// 넘어가라"는 뜻이다.
function classifyTransportFailure({
  networkError,
  parseError,
  httpOk,
  status,
  rateLimitRemaining,
  rateLimitReset,
}) {
  if (networkError) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: "네트워크 요청 자체가 실패(fetch 예외) -- 확인 불가",
    };
  }
  if (parseError) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: `응답 JSON 파싱 실패(status=${status ?? "?"}) -- 확인 불가`,
    };
  }
  if (httpOk === false) {
    if (status === 404) {
      return {
        verdict: CI_VERDICT.UNKNOWN,
        reason: "HTTP 404 -- 커밋을 못 찾음(오타/미푸시/저장소 불일치)",
      };
    }
    if (status === 403) {
      return classify403({ rateLimitRemaining, rateLimitReset });
    }
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: `HTTP 오류 응답(status=${status ?? "?"}) -- 확인 불가`,
    };
  }
  return null;
}

// ESLint complexity(<=12) 예산 때문에 본문 스키마 판정을 별 함수로 쪼갠다
// (classifyTransportFailure/classify403과 동일한 이유). null을 돌려주면
// "본문은 판정 가능한 형태, check_runs 배열 판정으로 넘어가라"는 뜻이다.
function classifyMalformedBody(parsed) {
  if (parsed === null || parsed === undefined || typeof parsed !== "object") {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: "응답 본문이 비어있거나 객체가 아님 -- 확인 불가",
    };
  }
  if (!("check_runs" in parsed)) {
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: "응답에 check_runs 필드 부재 -- 예상 스키마와 다름",
    };
  }
  return null;
}

export function classifyCiStatus({
  networkError = false,
  httpOk = null,
  status = null,
  parsed,
  parseError = false,
  rateLimitRemaining = null,
  rateLimitReset = null,
} = {}) {
  const transportFailure = classifyTransportFailure({
    networkError,
    parseError,
    httpOk,
    status,
    rateLimitRemaining,
    rateLimitReset,
  });
  if (transportFailure) return transportFailure;
  const malformedBody = classifyMalformedBody(parsed);
  if (malformedBody) return malformedBody;
  return classifyFromCheckRuns(parsed.check_runs);
}

// ---- 어댑터: 실제 fetch 실행 -----------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

// res.headers.get(name)이 있는 응답에서만 읽는다 -- 기존(1R/2R) 시험이
// 주입하는 최소 가짜 응답({status, ok, text})처럼 headers가 아예 없는
// 경우도 여전히 지원해야 하므로(회귀 0), 없으면 null로 조용히 접는다.
function readHeader(res, name) {
  if (!res || !res.headers || typeof res.headers.get !== "function")
    return null;
  const value = res.headers.get(name);
  return typeof value === "string" ? value : null;
}

// ⛔토큰 참조 0 -- Authorization 헤더를 세팅하지 않는다(공개 API 무인증
// 읽기, coder-task.md §3-1). 이 함수 본문 전체에 토큰/자격증명 변수가
// 없다는 사실 자체가 3-4-6 시험이 고정하는 계약이다.
export async function fetchCheckRuns({
  owner,
  repo,
  sha,
  fetchFn = fetch,
} = {}) {
  const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${sha}/check-runs`;
  let res;
  try {
    res = await fetchFn(url, {
      headers: { Accept: "application/vnd.github+json" },
    });
  } catch {
    return classifyCiStatus({ networkError: true });
  }
  const status = res.status;
  const httpOk = res.ok === true;
  const rateLimitRemaining = readHeader(res, "x-ratelimit-remaining");
  const rateLimitReset = readHeader(res, "x-ratelimit-reset");
  let text;
  try {
    text = await res.text();
  } catch {
    return classifyCiStatus({ networkError: true });
  }
  let parsed;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    return classifyCiStatus({ httpOk, status, parseError: true });
  }
  return classifyCiStatus({
    httpOk,
    status,
    parsed,
    rateLimitRemaining,
    rateLimitReset,
  });
}

// ---- 대기(폴링): 상한 필수 + UNKNOWN 즉시 중단 -----------------------------
//
// coder-task.md §3-3: 대기를 넣는다면 무한 대기 금지(상한 필수) +
// UNKNOWN이 나오면 즉시 중단(계속 기다리지 마라). 대기 전 한 번은 조회에
// 성공해야("도구가 살아 있다"는 확인) 대기에 들어간다.
//
// 정직 한계 ①: 공개 API는 공개 저장소에서만 무인증으로 읽힌다 -- 저장소가
// 비공개로 바뀌면 이 경로(그리고 이 폴러)는 못 쓴다(401/404로 즉시
// UNKNOWN이 되어 fail-loud하긴 하지만, "왜 안 되는지"는 이 모듈이 알려주지
// 않는다).
// 정직 한계 ②: 이 도구는 누가 호출할 때만 판정한다 -- 상시 감시(daemon)가
// 아니다. 폴링 상한(maxAttempts)을 넘기면 최종 상태를 그대로 반환하고
// 종료한다 -- 그 뒤로는 아무도 지켜보지 않는다.
// 정직 한계 ③(3R 신설, coder-task.md 3R §2⑸): 무인증 GitHub REST API는
// **시간당 60회**로 제한된다(도그푸딩 실측 X-RateLimit-Limit:60) -- 이
// 폴러를 20초 간격으로 돌리면 시간당 180회를 시도해 30분 안에 한도를 태운다
// (실제로 이 PR 자신의 CI를 감시하다 그렇게 소진됐다). 기본 간격을
// 60000ms(60초)로 올린 이유가 이거다 -- 시간당 정확히 60회, 즉 한도 전부를
// 이 폴러 하나가 다 쓴다고 가정해도 소진되지 않는 상한.
//
// 3R §2⑷ 결정: 한도 소진(reasonCode RATE_LIMIT_EXHAUSTED)을 만나도
// **즉시 중단**한다 -- "리셋까지 기다린다"를 고르지 않았다. 이유: (1) 이미
// UNKNOWN 즉시 중단 계약(정직 한계 ①/②와 같은 축)을 그대로 재사용할 수
// 있어 새 분기·새 상한 로직이 필요 없다(작을수록 안전). (2) 리셋까지
// 기다리는 옵션은 최악의 경우 거의 1시간을 대기해야 하는데, 그 사이
// 호출자(ORCH)는 CI가 실제로 끝났는지 전혀 모르는 채로 이 도구만 하염없이
// 잠들어 있게 된다 -- "무한 대기처럼 느껴지는 유한 대기"는 이 이슈가
// 애초에 없애려던 바로 그 실패 모드(1b_shown)와 체감상 구별이 안 된다.
// (3) 재시도 시각이 이미 `reason`/`retryAtKst`에 사람이 읽을 수 있게 실려
// 나가므로, "언제 다시 하면 되는지"는 호출자(사람 또는 ORCH)가 판단해서
// 스스로 재호출하면 된다 -- 그 판단을 이 폴러가 대신 떠안을 필요가 없다.
export async function pollCiStatus({
  owner,
  repo,
  sha,
  fetchFn = fetch,
  intervalMs = 60000,
  maxAttempts = 60,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onAttempt,
} = {}) {
  let last = await fetchCheckRuns({ owner, repo, sha, fetchFn });
  if (last.verdict === CI_VERDICT.UNKNOWN) {
    // "도구가 살아 있다"는 확인 자체가 실패 -- 대기에 들어가지 않는다.
    return { ...last, attempts: 1 };
  }
  let attempts = 1;
  if (typeof onAttempt === "function") onAttempt(attempts, last);
  while (last.verdict === CI_VERDICT.PENDING && attempts < maxAttempts) {
    await sleepFn(intervalMs);
    last = await fetchCheckRuns({ owner, repo, sha, fetchFn });
    attempts += 1;
    if (typeof onAttempt === "function") onAttempt(attempts, last);
    if (last.verdict === CI_VERDICT.UNKNOWN) {
      // 즉시 중단 -- PENDING으로 계속 기다리지 않는다(§3-3).
      return { ...last, attempts };
    }
  }
  return { ...last, attempts };
}

// ---- CLI --------------------------------------------------------------

function parseArgs(argv) {
  const args = { owner: "hykim82", repo: "HARNESSENGINEERING" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--commit") args.sha = argv[++i];
    else if (a === "--owner") args.owner = argv[++i];
    else if (a === "--repo") args.repo = argv[++i];
    else if (a === "--wait") args.wait = true;
    else if (a === "--max-attempts") args.maxAttempts = Number(argv[++i]);
    else if (a === "--interval-ms") args.intervalMs = Number(argv[++i]);
  }
  return args;
}

const invokedDirectly =
  process.argv[1] &&
  process.argv[1].replace(/\\/g, "/").endsWith("scripts/check/ci-status.mjs");

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sha) {
    console.error(
      "usage: node scripts/check/ci-status.mjs --commit <sha> [--owner <owner>] [--repo <repo>] [--wait] [--max-attempts N] [--interval-ms N(기본 60000)]",
    );
    process.exit(3);
  }
  const run = args.wait
    ? pollCiStatus({
        owner: args.owner,
        repo: args.repo,
        sha: args.sha,
        maxAttempts: args.maxAttempts,
        intervalMs: args.intervalMs,
        onAttempt: (n, r) =>
          console.error(`  [시도 ${n}] ${r.verdict} -- ${r.reason}`),
      })
    : fetchCheckRuns({ owner: args.owner, repo: args.repo, sha: args.sha });

  run.then((result) => {
    console.log(`${result.verdict} -- ${result.reason}`);
    process.exit(CI_EXIT_CODE[result.verdict]);
  });
}
