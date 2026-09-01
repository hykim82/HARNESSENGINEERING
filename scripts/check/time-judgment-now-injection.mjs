// HYK-414 1R -- 판별축: «절대시각 픽스처» + «시간 판정 진입점을 now 없이
// 호출» 두 조건이 겹치는 시험 호출을 기계로 찾는다(coder-task.md §2-2/§2-3).
//
// 시간 판정 진입점의 닫힌 목록: `now = Date.now()`가 기본값인 export를
// 실측(grep)으로 전부 찾아 열거했다(HYK-414 1R). 이 목록에 없는 진입점이
// 새로 생기면(같은 패턴으로 grep 재검증) 이 목록도 갱신해야 한다 --
// 갱신 누락은 §0 REGISTERED_CHECK 시험(아래)이 RED로 잡는다.
//
// `file`은 아래 전부 `scripts/check/` 또는 `scripts/supervisor/` 아래
// `.mjs` 파일이다(확장자를 일부러 뺐다 -- relay-handshake.test.mjs의
// HYK-344 3R 시험이 "따옴표로 감싼 'relay-handshake.mjs' 리터럴이 있는
// 비-시험 .mjs 파일 = CLI를 스폰하는 프로덕션 호출자"로 간주해 이
// 레지스트리를 오탐 offender로 잡는다 -- 이 파일은 스폰이 아니라 데이터
// 등록일 뿐이라 확장자를 떼어 그 특정 리터럴 매치를 피했다. 도구를 속이는
// 회피가 아니라 그 시험이 실제로 찾으려는 것(spawn 호출자)과 이 파일의
// 실제 용도가 다름을 반영한 것 -- 함수 이름만으로도 충분히 식별 가능).
export const TIME_JUDGMENT_ENTRY_POINTS = Object.freeze([
  { fn: "checkRelayHandshake", file: "relay-handshake" },
  { fn: "checkControlRoomFresh", file: "controlroom-fresh" },
  { fn: "checkSelfcheckFreshness", file: "selfcheck-freshness" },
  { fn: "checkCanaryReceipt", file: "selfcheck-inventory" },
  { fn: "judgeEntry", file: "selfcheck-inventory" },
  { fn: "checkHookWiringRegistered", file: "selfcheck-inventory" },
  { fn: "runInventory", file: "selfcheck-inventory" },
  { fn: "runSelfcheck", file: "selfcheck" },
  { fn: "runRateLimitStallOnce", file: "rate-limit-stall-wire" },
  { fn: "runReachOnce", file: "reach-report" },
  { fn: "runWatchOnce", file: "watch-run" },
]);

// 절대시각 픽스처 신호: `YYYY-MM-DD HH:MM`(초 포함/미포함 둘 다) 형태의
// 리터럴. 실사고 원문의 세 시각(dropped_at/finished_at/DONE)이 전부 이
// 모양이다.
const ABSOLUTE_TIMESTAMP_RE = /\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?\b/;

// call site로부터 여는 '('에 대응하는 닫는 ')'까지 텍스트를 괄호 균형으로
// 잘라낸다(정규식만으로는 중첩된 `{ }`/`(` 를 안전하게 못 자른다).
function extractBalancedCall(src, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return src.slice(openParenIdx, i + 1);
    }
  }
  return src.slice(openParenIdx); // 미종결(문법 오류) -- 호출부 전체를 넘긴다
}

// 한 테스트 파일에서 fn(...) 호출부를 전부 찾아 {index, argsText} 목록으로.
function findCallSites(src, fnName) {
  const sites = [];
  const re = new RegExp(`\\b${fnName}\\s*\\(`, "g");
  let m;
  while ((m = re.exec(src))) {
    const openParenIdx = m.index + m[0].length - 1;
    const argsText = extractBalancedCall(src, openParenIdx);
    sites.push({ index: m.index, argsText });
  }
  return sites;
}

function hasNowArg(argsText) {
  return /\bnow\b\s*[,:}]/.test(argsText) || /\bnow\s*:/.test(argsText);
}

// ★설계 결정(파일 전체 스코프, 시험 블록 스코프가 «아니다»): 원인이 된
// 실사고(relay-handshake-runner-receipt.test.mjs)의 절대시각 리터럴은
// 호출부가 속한 test() 블록 «안»이 아니라, 그 블록이 부르는 모듈 최상위
// 헬퍼(writeCoderRound)의 정의부 «안»에 있었다. 시험 블록으로 스코프를
// 좁히면(호출부-헬퍼 호출그래프를 추적하지 않는 한) 바로 이 모양의
// 재발을 못 잡는다 -- 그래서 이 스캐너는 의도적으로 "파일 안 어딘가에
// 절대시각 리터럴이 있다" + "그 파일이 진입점을 now 없이 부른다"를
// 파일 단위로 겹쳐 본다. 정밀도보다 재현율을 택한 것 -- 과탐(같은
// 파일의 무관한 절대시각과 엮임)은 허용하고 미탐(§0 "미열거=위험"과
// 같은 원칙)을 피한다. 과탐이 실제로 많이 나온다는 뜻은 곧 baseline(재발
// 방지 원장)이 그만큼 크다는 뜻이고, 그 크기 자체가 §4 정직 의무에 적을
// "이 탐지기가 못 잡는 것"의 재료다.
function fileHasAbsoluteTimestamp(src) {
  return ABSOLUTE_TIMESTAMP_RE.test(src);
}

// 시험 파일 하나를 진입점 목록 기준으로 스캔해 위험 호출부를 반환한다.
export function scanTestFileForRiskyCalls(filePath, src) {
  const risky = [];
  if (!fileHasAbsoluteTimestamp(src)) return risky;
  for (const { fn } of TIME_JUDGMENT_ENTRY_POINTS) {
    for (const site of findCallSites(src, fn)) {
      if (hasNowArg(site.argsText)) continue; // now를 넘겼다 -- 안전
      risky.push({ file: filePath, fn, index: site.index });
    }
  }
  return risky;
}

// 한 소스 파일(라이브러리 .mjs, 시험 파일 아님)에서 `now = Date.now()`가
// 기본값인 export function을 전부 찾는다 -- TIME_JUDGMENT_ENTRY_POINTS
// 목록이 최신인지 재검증하는 용도(닫힌 목록의 "닫힘"을 기계로 재확인).
export function findExportedNowDefaultFunctions(src) {
  const found = [];
  const re = /export function\s+(\w+)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const fnName = m[1];
    const openParenIdx = m.index + m[0].length - 1;
    const paramsText = extractBalancedCall(src, openParenIdx);
    if (/\bnow\s*=\s*Date\.now\(\)/.test(paramsText)) {
      found.push(fnName);
    }
  }
  return found;
}
