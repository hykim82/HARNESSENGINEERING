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
// ESLint complexity(<=12) 예산 때문에 전송 계층 실패(네트워크/파싱/HTTP)의
// 판정을 별 함수로 쪼갠다. null을 돌려주면 "전송 계층은 통과, 본문 판정으로
// 넘어가라"는 뜻이다.
function classifyTransportFailure({
  networkError,
  parseError,
  httpOk,
  status,
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
    return {
      verdict: CI_VERDICT.UNKNOWN,
      reason: `HTTP 오류 응답(status=${status ?? "?"}) -- 확인 불가`,
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
} = {}) {
  const transportFailure = classifyTransportFailure({
    networkError,
    parseError,
    httpOk,
    status,
  });
  if (transportFailure) return transportFailure;
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
  return classifyFromCheckRuns(parsed.check_runs);
}

// ---- 어댑터: 실제 fetch 실행 -----------------------------------------------

const GITHUB_API_BASE = "https://api.github.com";

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
  return classifyCiStatus({ httpOk, status, parsed });
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
export async function pollCiStatus({
  owner,
  repo,
  sha,
  fetchFn = fetch,
  intervalMs = 5000,
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
      "usage: node scripts/check/ci-status.mjs --commit <sha> [--owner <owner>] [--repo <repo>] [--wait] [--max-attempts N] [--interval-ms N]",
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
