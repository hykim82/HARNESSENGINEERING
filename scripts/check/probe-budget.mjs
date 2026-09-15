// HYK-467 (coder-task.md §B-3) -- 2026-09-10 실사고: 감시기 3개가 각자
// "나는 시간당 12회만 부른다"는 개별 예산을 지켰는데도, 셋을 합치면
// 시간당 36회 + 수동 확인이 더해져 GitHub 무인증 API 한도(시간당 60회,
// ci-status.mjs 실측)를 넘겼다. 개별 예산은 각 호출자가 "나 말고 다른
// 호출자가 있다"는 사실을 모르기 때문에 원천적으로 못 막는다 -- 예산은
// «감시기 전체 합계»로 세야 한다.
//
// 설계: 코어(judgeProbeBudget)는 순수 함수 -- 이미 있는 타임스탬프
// 목록·현재 시각·창 길이·상한만 받아 판정한다. 어댑터(recordProbe)가
// 공유 파일(여러 프로세스가 같은 경로를 가리키면 그게 곧 "합계 카운터"가
// 된다)을 읽고-판정하고-(허용될 때만)쓴다. ⛔허용 안 될 확률(예산 소진)에
// 도 파일에 흔적을 남기지 않는다 -- 소진된 뒤에도 계속 시도가 "기록"돼
// 버리면 다음 판정이 실제보다 더 나쁘게 보인다(과잉 억제), 반대로 소진
// 상태에서 쓰기를 건너뛰는 것은 정확히 "이번 건은 안 셀 만큼 안 나갔다"는
// 사실과 일치한다.
//
// 동시성 정직 한계: 이 파일은 진짜 파일 잠금(flock 등)을 쓰지 않는다 --
// 두 프로세스가 정확히 같은 밀리초에 읽고 쓰면 마지막 쓰기가 이긴다(레이스
// 가능). 이 하네스의 다른 side-channel 파일들(unconsumed-vanish-state.json
// 등)과 같은 수준의 "best-effort 협조 카운터"다 -- 완벽한 상호배제가
// 아니라 "따로따로 셀 때보다는 훨씬 낫다"가 이 라운드의 목표다.

export const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1시간
// GitHub 무인증 REST API 실측 한도(ci-status.mjs 주석, X-RateLimit-Limit:60)
// 와 동일한 상수를 재사용한다 -- 다른 값을 새로 지어내지 않는다.
export const DEFAULT_CAP_PER_HOUR = 60;

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// judgeProbeBudget({priorProbeTimestampsMs, nowMs, windowMs, capPerHour}) ->
// {ok, countInWindow, capPerHour, prunedTimestampsMs}
//
// - `priorProbeTimestampsMs`: 이미 기록된 과거 프로브 시각들(epoch ms).
//   배열이 아니거나 원소가 유효하지 않으면 안전측으로 "판정 불가하다고
//   보지 않고" 그냥 무시한다(손상된 값 = 없었던 것으로 -- 과거 기록이
//   깨졌다고 새 프로브까지 막는 것은 이 축의 책임이 아니다).
// - `prunedTimestampsMs`: 창 밖으로 나간 옛 기록을 제거한 목록 -- 호출자가
//   이 값을 그대로 저장하면 상태 파일이 무한히 자라지 않는다.
export function judgeProbeBudget({
  priorProbeTimestampsMs,
  nowMs,
  windowMs = DEFAULT_WINDOW_MS,
  capPerHour = DEFAULT_CAP_PER_HOUR,
} = {}) {
  const now = isFiniteNumber(nowMs) ? nowMs : Date.now();
  const w =
    isFiniteNumber(windowMs) && windowMs > 0 ? windowMs : DEFAULT_WINDOW_MS;
  const cap =
    isFiniteNumber(capPerHour) && capPerHour > 0
      ? capPerHour
      : DEFAULT_CAP_PER_HOUR;
  const source = Array.isArray(priorProbeTimestampsMs)
    ? priorProbeTimestampsMs
    : [];
  const prunedTimestampsMs = source
    .filter((t) => isFiniteNumber(t) && t <= now && t > now - w)
    .sort((a, b) => a - b);
  const countInWindow = prunedTimestampsMs.length;
  return {
    ok: countInWindow < cap,
    countInWindow,
    capPerHour: cap,
    prunedTimestampsMs,
  };
}

function readState(readFn, budgetPath) {
  try {
    const raw = readFn(budgetPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.probeTimestampsMs)
      ? parsed.probeTimestampsMs
      : [];
  } catch {
    // 파일이 없거나(첫 호출) 손상됐다 -- 둘 다 "기록된 프로브가 없다"와
    // 동일하게 취급한다(손상=예산 소진으로 안전측 과잉 차단하지 않는다,
    // 이 축의 실패 모드는 "차단 못 함"이 아니라 "합계가 아직 0으로
    // 보인다"뿐이라 위험이 작다 -- 실제 GitHub 쪽 429/403은 그 자체로
    // ci-status.mjs가 이미 UNKNOWN으로 잡는다).
    return [];
  }
}

// ESLint complexity(<=12) 예산 때문에 "상태 파일에 이 타임스탬프 목록을
// best-effort로 쓴다"는 recordProbe의 두 갈래(허용/거부) 공통 동작을
// 별 함수로 뽑는다(orca-posture-check.mjs의 하위 판정 분리 선례와 동일
// 이유) -- 판정 로직은 그대로, 쓰기 시도만 한 곳에 모은다.
function bestEffortWriteState({
  budgetPath,
  timestampsMs,
  writeFn,
  mkdirFn,
  existsFn,
  dirnameFn,
}) {
  try {
    const dir = dirnameFn ? dirnameFn(budgetPath) : null;
    if (dir && mkdirFn && existsFn && !existsFn(dir)) {
      mkdirFn(dir, { recursive: true });
    }
    writeFn(
      budgetPath,
      JSON.stringify({ probeTimestampsMs: timestampsMs }),
      "utf8",
    );
  } catch {
    // best-effort -- 쓰기 실패해도 이미 확정된 판정 결과(ok/countInWindow)
    // 는 바꾸지 않는다(이 축의 목적은 "합산해서 도와준다"이지 새로운
    // 차단/예외 지점을 만드는 게 아니다).
  }
}

// recordProbe({budgetPath, nowMs, windowMs, capPerHour, readFn, writeFn,
// mkdirFn, existsFn, dirname}) -> {ok, countInWindow, capPerHour}
//
// 호출자는 실제 외부 호출(fetch 등)을 하기 «전»에 이 함수를 부른다.
// ok:false 면 실제 호출을 생략해야 한다(이 함수 자신은 호출을 막지
// 않는다 -- 판정만 한다, 코어와 동일한 "판단은 여기, 집행은 호출자"
// 관례).
export function recordProbe({
  budgetPath,
  nowMs = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  capPerHour = DEFAULT_CAP_PER_HOUR,
  readFn,
  writeFn,
  mkdirFn,
  existsFn,
  dirnameFn,
} = {}) {
  const prior = readState(readFn, budgetPath);
  const judged = judgeProbeBudget({
    priorProbeTimestampsMs: prior,
    nowMs,
    windowMs,
    capPerHour,
  });
  const writeArgs = { budgetPath, writeFn, mkdirFn, existsFn, dirnameFn };
  if (!judged.ok) {
    // 예산이 이미 소진됐다 -- 이 시도는 "일어나지 않을 시도"이므로 새
    // 타임스탬프(nowMs)는 저장하지 않는다(위 헤더 설계 근거). pruned
    // 목록만이라도 저장해 상태 파일이 계속 자라는 것은 막는다.
    bestEffortWriteState({
      ...writeArgs,
      timestampsMs: judged.prunedTimestampsMs,
    });
    return {
      ok: false,
      countInWindow: judged.countInWindow,
      capPerHour: judged.capPerHour,
    };
  }
  const nextTimestamps = [...judged.prunedTimestampsMs, nowMs];
  bestEffortWriteState({ ...writeArgs, timestampsMs: nextTimestamps });
  return {
    ok: true,
    countInWindow: judged.countInWindow + 1,
    capPerHour: judged.capPerHour,
  };
}
