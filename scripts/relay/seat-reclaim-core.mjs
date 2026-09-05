// HYK-431 1R/2R (coder-task.md §2) -- "끝난 레인의 좌석" 회수 판정 순수 코어.
// 부작용 0 · 시각/랜덤/fs/network 0(teardown-core.mjs와 동일 원칙, G9와
// 동형: 이 파일은 `orca` 문자열도 pane key/PID 원문도 모른다 -- 그런 것은
// 호출자가 만드는 inventory 봉투 안 값일 뿐이다). 이 파일이 내는 판정은
// "지금 이 좌석을 회수 대상으로 볼 수 있는가"뿐이다. 파괴(`terminal
// close`) 자체는 이 파일이 절대 실행하지 않는다(§4 답 참조, coder-task.md
// §2⑷ 비타협: 실행 호출은 이 라운드에서 만들지도 부르지도 않는다).
//
// ---- §2⑴ 회수 대상의 "정의" (사례 나열이 아니라 규칙) ----
//
// 좌석은 다음 다섯 조건을 **모두** 만족할 때만 RECLAIM_ELIGIBLE이다:
//   1) 그 좌석에 식별 가능한 대상(`seat.paneKey`)이 있다(null이 아니다).
//   2) 그 좌석이 `policy.protectedSeats`에 정확히(exact match) 나열돼
//      있지 않다 -- 그리고 그 판단 자체가 가능해야 한다(아래 "입력 공간"
//      규칙 참조).
//   3) 그 좌석에 배정된 배차(dispatch)의 `completedAt`이 null이 아니고,
//      **파싱 가능하며 `nowMs`를 넘지 않는다**(= 배차가 끝났다는 구조적
//      신호가 "미래도 쓰레기값도 아니다". "status 문자열이 무엇이든"은
//      여전히 상관 없다 -- 아래 §2⑵에서 이 선택의 이유를 설명한다).
//   4) 배차 관측과 활동(activity) 관측이 둘 다 `observable:true`고,
//      활동의 idle 시간(`activity.idleMs`)이 **알려져 있다**(null이 아니다).
//   5) 배차가 끝난 뒤 흐른 시간이 `policy.minIdleMs` 이상이다(유예 구간
//      -- §2⑸에서 이유 설명).
// 위 다섯 조건 중 하나라도 거짓이면 결과는 RECLAIM_ELIGIBLE이 **아니다**
// (실패 방향은 언제나 "회수하지 않는다" 쪽 -- coder-task.md §1-2
// fail-closed 비타협).
//
// ---- §2⑴ "입력 공간"을 닫는 규칙(2R -- 반례를 하나씩 막지 않는다) ----
//
// 1R의 결함은 "분기는 닫혔는데 입력은 안 닫혔다"였다 -- `completedAt`이
// null/non-null 이분(binary) 축이라는 것은 맞았지만, "non-null 문자열"
// 이라는 조건이 **그 문자열이 실제로 무엇을 뜻하는지는 검사하지 않았다**.
// 2R은 하나의 일반 규칙으로 그 구멍을 닫는다:
//
//   ★규칙: "이 필드가 채워져 있다는 사실 자체가 판정에 쓰일 값이면,
//   그 값은 **자기 타입의 유효한 값 범위 안**에 있어야만 '채워졌다'로
//   센다. 범위 밖 값(파싱 불가 문자열, 미래 시각, 배열이어야 하는데
//   아닌 값, null 식별자, "관측 가능한데 값은 모른다"는 모순)은 전부
//   '채워지지 않은 것'과 같은 취급(fail-closed 분기)을 받는다."
//
// 이 규칙에서 아래 다섯 파생 검사가 **나온다**(발견된 반례를 보고 나중에
// 추가한 게 아니라, 규칙을 필드마다 적용한 결과다):
//   - `dispatch.completedAt`: "non-null 문자열"이 아니라 "null 또는
//     **파싱 가능한(`Date.parse`가 유한수를 내는) 문자열**"이 유효 범위다.
//     `'not-a-date'`·`'2026-99-99'`·공백 문자열은 파싱 불가이므로 스키마
//     경계에서 걸러진다(SCHEMA_INVALID) -- "미래/과거"를 몰라도 파싱
//     가능성만으로 세 반례가 동시에 닫힌다.
//   - `dispatch.completedAt`이 파싱은 되지만 **`nowMs`보다 미래**면, 그
//     "배차가 끝났다"는 신호를 신뢰하지 않는다(아래 §2⑷에서 `nowMs`를
//     누가 대는지 설명) -- 이것만은 스키마(순수 형태) 검사로 못 닫는다,
//     "지금이 언제인지"가 필요하기 때문이다.
//   - `seat.paneKey`가 null이면 "회수 대상 자체가 없다" -- 무엇을
//     회수하라는 것인지 식별할 수 없으므로 다른 모든 guard보다 먼저
//     TARGET_UNIDENTIFIED로 막는다.
//   - `policy.protectedSeats`가 배열이 아니면(결손·문자열·기타) "보호
//     목록을 읽을 수 없다"는 뜻이지 "보호 목록이 비어 있다"는 뜻이
//     아니다 -- 전자를 후자로 조용히 바꿔치기하지 않는다(1R의 실제 결함).
//     읽을 수 없으면 안전측으로 접어 PROTECTED 취급(회수 금지)한다.
//   - `activity.idleMs`가 null인데 `activity.observable`이 true인 것은
//     모순 입력이다("관측 가능한데 값을 모른다") -- 이 모순을 0 유예
//     정책에서의 숫자 비교(`null < 0` → JS coercion으로 `0 < 0` → false
//     → 통과)에 맡기지 않고, idle 시간을 "모른다"로 명시 처리해 유예
//     구간으로 접는다(WITHIN_GRACE_PERIOD, fail-closed).
//
// ---- §2⑴(3R) 축을 올린다: 입력 계약을 "선언"하고 검증기를 거기서
//      "파생"시킨다 (REVIEW 1R P1-1 반려 원인 제거) ----
//
// 2R은 위 다섯 파생 검사를 필드마다 손으로 짠 `isValidXField` 함수로
// 적용했다. REVIEW가 잡은 P1-1: `policy.protectedSeats`는 "배열인가"만
// 보고 "배열의 **원소**가 자기 타입 범위 안에 있는가"는 안 봤다 --
// `[null]`·`[1]`·`[{}]`·`['other', null]`이 전부 "정상 목록"으로
// 통과해 RECLAIM_ELIGIBLE로 샜다(fail-open). ★이건 §2⑴ 규칙이 틀려서가
// 아니다 -- 그 규칙을 "배열 자체"에는 적용하면서 "배열 원소"에는 적용을
// 빼먹은, **적용 누락**이다(coder-task.md §1-1). 1R→2R→REVIEW가 "같은
// 형태, 한 겹씩 안쪽"으로 반려된 것도 이 때문이다: 손으로 필드를 훑는
// 방식은 훑는 손이 안 닿는 겹(중첩)을 매번 하나씩 남긴다.
//
// 3R은 손으로 훑는 방식 자체를 버린다. 아래 TNull/TBoolean/TExact/
// TNonEmptyString/TParsableTimestamp/TNonNegativeFiniteNumber/TUnion/
// TArrayOf/TObject 조합자로 §2⑴ 규칙("채워진 값은 자기 타입의 유효
// 범위 안에 있어야 '채워졌다'로 센다")을 **한 번만 선언**하고,
// `SEAT_INVENTORY_SCHEMA`·`PROTECTED_SEATS_SCHEMA`는 그 선언의
// 인스턴스일 뿐이다 -- `isValidSeatInventoryShape`와 `classifyProtection`의
// 검사 로직은 이제 그 선언을 구동하기만 한다(따로 로직을 갖지 않는다).
// 조합자는 외부 스키마 라이브러리(zod 등)를 쓰지 않는다(zero-import
// 순수 코어 관례) -- 이 코어가 실제로 필요로 하는 형태(원자값/합집합/
// 배열/객체)로만 표현력을 최소화했다.
//
// ---- §2⑵ 이 계약이 "중첩된 값"에도 적용됨을 무엇으로 보증하는가 ----
//
// 보증의 실체는 **재귀**다: `TArrayOf(elementSchema)`는 배열 "그릇"이
// 아니라 배열의 **모든 원소**에 `elementSchema.check`를 적용하고,
// `TObject(fieldSchemas)`는 선언된 각 속성 "값"에 그 속성의 스키마를
// 적용한다. 원소나 속성 자체가 다시 TObject/TArrayOf이면(예: 이 코어가
// 미래에 "배차 목록의 배열"을 받게 되어도) 같은 두 함수가 그대로 한
// 겹 더 재귀한다 -- "중첩 k겹"을 손으로 k번 더 짤 필요가 없다. 이
// 재귀가 정확히 P1-1을 막는다: `PROTECTED_SEATS_SCHEMA =
// TArrayOf(TNonEmptyString())`는 배열 자체가 배열인지(`Array.isArray`)
// **그리고** 모든 원소가 비어있지 않은 문자열인지를 한 선언으로 동시에
// 요구하므로, `[null]`·`[1]`·`[{}]`처럼 "그릇은 배열, 내용물은 무효"인
// 입력이 더는 통과하지 못한다(원소 하나라도 실패하면 `.every`가
// false를 내고 배열 전체가 무효로 접힌다).
//
// "전수"의 근거는 여전히 표본 수가 아니라 **분기 구조가 닫혀 있다는
// 것**이지만, 3R은 그 구조를 "필드마다 개별로 짠 함수 여러 개"에서
// "선언 하나 + 그 선언을 그대로 구동하는 재귀 조합자 두 개"로 좁혔다 --
// 새 필드/새 중첩이 추가돼도 §2⑴ 규칙을 그 자리에 조합자로 한 번
// 선언하면 되고, "그 필드의 반례 목록"을 손으로 다시 수집할 필요가
// 없다. 되돌림 변이(§9 재현)로 각 guard가 load-bearing임을, §5 신규
// 시험으로 12개 반례(8개 기존 + P1-1의 4개)가 계약 필드 값을 직접
// 검사해 닫혔음을 함께 보증한다(표본 근거 + 구조 근거의 결합, 표본
// 단독이 아니다).
//
// ★이 보증이 "못 덮는 것"(정직하게, §2⑵ 질문 답 -- 등급 포함):
//   1) [P2급] **스키마가 닫혀 있지 않다** -- `TObject`는 선언된 키만
//      검사하고 여분의 키를 거부하지 않는다(예: `seat`에 알 수 없는
//      속성이 더 있어도 통과). 이 코어는 선언된 필드만 읽으므로 현재
//      harm path는 없지만, "여분 필드가 있으면 무효로 본다"는 요구가
//      생기면 별도 조합자(`TExactObject` 류)가 필요하다 -- 이번 라운드
//      범위 밖(§0 범위 확대 금지)이라 추가하지 않는다.
//   2) [P3급] **원소 간 상호 제약은 표현하지 않는다** -- 예:
//      "protectedSeats에 중복 원소가 없어야 한다"는 이 조합자로 못
//      막는다(원소 각각의 타입만 본다, 원소 간 관계는 못 본다). 현재
//      요구사항에 그런 제약이 없으므로 harm path 없음.
//   3) [P1급으로 보지 않음, 1R/2R부터 이어지는 기존 정직 한계] `completedAt`을
//      채우는 쪽(호출자/어댑터)이 실제로 배차가 끝났을 때만 그 필드를
//      채운다는 **상위 계약**은 이 코어가 강제할 수 없다 -- 그 계약이
//      깨지면(예: 아직 안 끝난 배차에 실수로 "과거의" completedAt이
//      채워짐) 이 코어는 정직하게 속는다. 이건 "값이 자기 타입 범위
//      안에 있는가"를 넘어 "그 값이 사실과 일치하는가"를 요구하므로
//      어떤 스키마 조합자로도 원리적으로 못 닫는다(다른 코어도 동일
//      경계 -- wake-decide-core.mjs도 `nowMs`가 진짜 현재 시각인지는
//      검증하지 않는다).
//
// ---- §2⑶ 회수 "누락"이 이상으로 열리는가 ----
// judgeReclaimAnomaly가 별도 축을 낸다(아래) -- 좌석 "개수" 단독 임계는
// 폐기(coder-task.md §2⑶ 비타협): count>0인데 가용 메모리가 바닥이 아니면
// WATCH(가시성만)에서 멈추고 ANOMALY로 올리지 않는다. ANOMALY는 반드시
// "회수 못 한 좌석이 있다" AND "가용 메모리가 바닥"(또는 메모리 자체를
// 관측 못 함 -- 아래 이유) 둘 다일 때만 뜬다.
//
// ---- §2⑷ "미래 시각"은 누구 몫인가 ----
// 미래 여부는 호출자가 주입한 기준시각 없이는 순수 코어에서 결정할 수
// 없다(검토자 지적, coder-task.md §2⑷). 이 저장소의 기존 코어 관례가
// 이미 이 질문에 답을 냈다 -- `wake-decide-core.mjs`(§3-A)는 `nowMs`를
// **인자로만** 받고 `Date.now()`를 스스로 부르지 않는다("현재 시각은
// `nowMs` 인자로만 받는다"). 이 코어도 같은 관례를 따른다:
// `judgeSeatReclaim({inventory, policy, nowMs})`. `nowMs`가 유한수가
// 아니면(결손·NaN·문자열) "미래 여부를 판단할 재료가 없다"는 뜻이므로
// SCHEMA_INVALID로 fail-closed 접는다(회수 금지) -- `wake-decide-core.mjs`가
// `nowMs`가 유한수가 아니면 UNDECIDABLE로 접는 것과 동형 원칙, 다만 이
// 코어는 verdict 어휘가 아니라 기존 SCHEMA_INVALID 버킷을 재사용한다(§1-3
// 비타협: 새 반환 형태를 발명하지 않는다).
// 대가: 호출자(어댑터)가 진짜 "지금"이 아닌 시각을 `nowMs`로 주입하면
// 이 코어는 정직하게 속는다 -- 그 신뢰는 이 코어 밖(어댑터가
// `Date.now()`를 정확히 한 번, 판정 직전에 호출하는가)의 책임이다.
//
// ---- §2⑸ 실행은 누가 하는가 ----
// 이 파일은 판정까지다. `terminal close`류 실행 호출은 이 저장소의 다른
// 어떤 스크립트도 이 라운드에서 만들지 않는다(§0 합성 표적 규율) --
// 그 호출은 이 저장소 밖 관제실(control room)의 "실행 한 줄"만 맡는다
// (coder-task.md §3, 판정/시험은 저장소 안, 실행 호출만 관제실). 관제실
// 코드는 이 파일의 judgeSeatReclaim만 부르고, 반환된 reclaimEligible이
// true인 좌석에 한해서만 자신의 실행 한 줄을 돌려야 한다 -- 그 결선
// 자체는 이 저장소가 검사할 수 없으므로(CI 앵커가 이 저장소 밖에 없다),
// 이 코어가 보증하는 것은 "판정이 맞다"까지이지 "관제실이 그 판정을
// 실제로 따랐다"까지가 아니다(정직 한계).
//
// ---- §2⑶(P1-2) 두 export 모두 어떤 인자에도 throw하지 않는다 ----
// 이 저장소의 순수 코어 관례(unconsumed-core.mjs 헤더가 정본, §1-3
// 정문 인용)를 그대로 따른다: "throw로 판정을 대신하지 않는다 -- 인자가
// 무엇이든 예외 없이 `{ok/reclaimEligible, ...}`류 판정 객체를 반환한다."
// `judgeSeatReclaim(null)`·`judgeReclaimAnomaly(null)`도 destructuring을
// 인자 자체에 직접 걸지 않고(`{a,b} = arg` 형태는 `arg`가 명시적 null이면
// 기본값이 적용되지 않아 던진다) `isPlainObject(arg) ? arg : {}`로 먼저
// 안전하게 감싼 뒤에만 필드를 꺼낸다 -- 그 결과 스키마 검사에서 자연스럽게
// SCHEMA_INVALID/INPUT_INVALID(둘 다 fail-closed/fail-open 각자의 비대칭
// 방향)로 떨어진다.

// ---- §2⑴(6R) 관측을 한 번으로 줄인다 -- 검증기와 소비자가 같은 물건을
//      본다 (HYK-431 6R, coder-task.md §2-2) ----
//
// 3R~5R은 "검사 로직이 입력에 조종되지 않게" 만들었다(선언적 조합자 +
// 원형 메서드 차용). 검토 6R은 그 다음 겹을 뚫었다: 로직이 원형 것이어도
// **그 로직이 읽는 값**은 여전히 입력이 매 호출마다 새로 정한다.
// `Array.isArray(proxy)===true`인 Proxy가 `length`를 0으로 보고하면
// PROTECTED_SEATS_SCHEMA도 통과하고(원소가 "없으니" vacuously true)
// classifyProtection의 exact 대조도 빈 목록을 훑어 -- 보호받는 좌석이
// RECLAIM_ELIGIBLE이 됐다.
//
// 6R의 수리는 검사를 하나 더 붙이는 게 아니라 **읽는 횟수를 1로 만드는**
// 것이다: judgeSeatReclaim/judgeReclaimAnomaly는 진입 즉시 인자를
// plain-snapshot.mjs로 한 번 읽어 깊게 얼린 평범한 자료로 고정하고, 그
// 아래 모든 스키마 검사·분류·evidence는 **그 고정본만** 본다. 원본은 다시
// 만지지 않는다. 그래서 (a) 호출마다 값을 바꾸는 입력도 판정에 관여할
// 두 번째 기회가 없고 (b) 스키마가 통과시킨 그 값이 그대로 분류·evidence로
// 흐르며 (c) 고정본에는 getter/Proxy/프로토타입 재정의가 남지 않는다.
// 아래 TArrayOf/classifyProtection의 원형 메서드 차용(4R/5R)은 그대로
// 남긴다 -- 고정본에는 이미 불필요하지만 방어가 줄지 않는다.

import { snapshotPlainData } from "./plain-snapshot.mjs";

export const SEAT_RECLAIM_SCHEMA_VERSION = 1;

export const SEAT_ELIGIBILITY = Object.freeze({
  PROTECTED: "PROTECTED",
  UNOBSERVABLE: "UNOBSERVABLE",
  DISPATCH_ACTIVE: "DISPATCH_ACTIVE",
  WITHIN_GRACE_PERIOD: "WITHIN_GRACE_PERIOD",
  TARGET_UNIDENTIFIED: "TARGET_UNIDENTIFIED",
  RECLAIM_ELIGIBLE: "RECLAIM_ELIGIBLE",
});

export const SEAT_REASON = Object.freeze({
  SCHEMA_INVALID: "SEAT_RECLAIM_SCHEMA_INVALID",
  // HYK-431 잔여 축 B: inventory 형상 실패와 nowMs 결손은 원인이 다른데
  // 4R 이전에는 둘 다 SCHEMA_INVALID 하나로 접혀 "무엇이 왜 걸렸는지"가
  // 안 보였다. fail-closed 판정(eligibility/reclaimEligible)은 그대로
  // 두고 reason만 원인별로 가른다(judgeSeatReclaim 진입 가드 참조).
  NOW_MS_INVALID: "SEAT_RECLAIM_NOW_MS_INVALID",
  TARGET_UNIDENTIFIED: "SEAT_RECLAIM_TARGET_UNIDENTIFIED",
  PROTECTED_LIST_INVALID: "SEAT_RECLAIM_PROTECTED_LIST_INVALID",
  PROTECTED_SEAT: "SEAT_RECLAIM_PROTECTED_SEAT",
  DISPATCH_UNOBSERVABLE: "SEAT_RECLAIM_DISPATCH_UNOBSERVABLE",
  DISPATCH_ACTIVE: "SEAT_RECLAIM_DISPATCH_ACTIVE",
  DISPATCH_COMPLETED_AT_FUTURE: "SEAT_RECLAIM_DISPATCH_COMPLETED_AT_FUTURE",
  ACTIVITY_UNOBSERVABLE: "SEAT_RECLAIM_ACTIVITY_UNOBSERVABLE",
  ACTIVITY_IDLE_UNKNOWN: "SEAT_RECLAIM_ACTIVITY_IDLE_UNKNOWN",
  WITHIN_GRACE_PERIOD: "SEAT_RECLAIM_WITHIN_GRACE_PERIOD",
  ELIGIBLE: "SEAT_RECLAIM_ELIGIBLE",
});

export const ANOMALY_STATUS = Object.freeze({
  OK: "OK",
  WATCH: "WATCH",
  ANOMALY: "ANOMALY",
});

export const ANOMALY_REASON = Object.freeze({
  INPUT_INVALID: "SEAT_RECLAIM_ANOMALY_INPUT_INVALID",
  NO_BACKLOG: "SEAT_RECLAIM_ANOMALY_NO_BACKLOG",
  BACKLOG_MEMORY_OK: "SEAT_RECLAIM_ANOMALY_BACKLOG_MEMORY_OK",
  BACKLOG_MEMORY_UNOBSERVABLE:
    "SEAT_RECLAIM_ANOMALY_BACKLOG_MEMORY_UNOBSERVABLE",
  BACKLOG_MEMORY_BELOW_FLOOR: "SEAT_RECLAIM_ANOMALY_BACKLOG_MEMORY_BELOW_FLOOR",
});

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}
// §2⑴ 규칙의 첫 파생: "채워진 값"은 자기 타입 범위 안에 있어야 한다 --
// 타임스탬프 문자열의 유효 범위는 "null 아니면 Date.parse가 유한수를
// 내는 문자열"이다(파싱 불가 문자열은 "채워지지 않은 것"과 동급).
function isParsableTimestamp(v) {
  return isNonEmptyString(v) && Number.isFinite(Date.parse(v));
}

// ---- §2⑴(3R) 최소 스키마 조합자 -- 위 §2⑴/§2⑵ 주석이 "왜"를 설명한다.
// 각 T* 는 `{ check(v): boolean }`을 반환하는 순수 함수다. 부작용 0,
// 예외 0(check는 어떤 v에도 boolean만 낸다) -- 이 코어의 나머지 함수와
// 같은 관례.
function TNull() {
  return { check: (v) => v === null };
}
function TBoolean() {
  return { check: (v) => typeof v === "boolean" };
}
function TExact(value) {
  return { check: (v) => v === value };
}
function TNonEmptyString() {
  return { check: isNonEmptyString };
}
function TParsableTimestamp() {
  return { check: isParsableTimestamp };
}
function TNonNegativeFiniteNumber() {
  return { check: (v) => Number.isFinite(v) && v >= 0 };
}
// 합집합 -- 여러 스키마 중 하나만 만족하면 된다(예: "null 또는 파싱
// 가능한 타임스탬프"). 순서는 판정에 영향 없다(각 check가 순수 술어).
function TUnion(...schemas) {
  return { check: (v) => schemas.some((s) => s.check(v)) };
}
// 배열 원소 계약 -- ★P1-1을 닫는 조합자. 배열 "그릇"만이 아니라
// **모든 원소**에 elementSchema를 적용한다(빈 배열은 vacuously 통과 --
// "목록이 비어 있다"는 유효 상태이지 무효 상태가 아니다).
function TArrayOf(elementSchema) {
  return {
    // HYK-436: `v.every(...)`는 v 자신의 메서드를 부른다 -- v가 Array를
    // 상속하며 every를 재정의하면 검사 자체가 입력에 의해 조종된다
    // (검토 4R 실증: EveryBypass -> [null]이 형상 검사를 통과). 원형의
    // 원본 every를 v에 "빌려" 호출하면(Function.prototype.call) v의
    // 자체 오버라이드는 조회되지 않는다 -- v는 순회 대상 데이터일 뿐이다.
    check: (v) =>
      Array.isArray(v) &&
      Array.prototype.every.call(v, (el) => elementSchema.check(el)),
  };
}
// 객체 속성 계약 -- 선언된 각 키의 값에 그 키의 스키마를 재귀 적용한다
// (속성 값이 다시 TObject/TArrayOf여도 그대로 한 겹 더 재귀). 선언되지
// 않은 여분의 키는 검사하지 않는다(§2⑵ "못 덮는 것" ①에 기록).
function TObject(fieldSchemas) {
  return {
    check(v) {
      if (!isPlainObject(v)) return false;
      return Object.keys(fieldSchemas).every((k) =>
        fieldSchemas[k].check(v[k]),
      );
    },
  };
}

// ---- §2⑴(3R) 이 코어가 받는 입력의 "선언된" 계약 -------------------
// inventory 봉투 전체를 한 번에 선언한다. 각 필드의 유효 범위는 위
// §2⑴ 목록과 동일하되, 이제 TObject 중첩으로 "선언"이다 --
// isValidSeatInventoryShape는 이 선언을 그대로 구동만 한다.
const SEAT_INVENTORY_SCHEMA = TObject({
  schemaVersion: TExact(SEAT_RECLAIM_SCHEMA_VERSION),
  seat: TObject({ paneKey: TUnion(TNull(), TNonEmptyString()) }),
  dispatch: TObject({
    completedAt: TUnion(TNull(), TParsableTimestamp()),
    observable: TBoolean(),
  }),
  activity: TObject({
    idleMs: TUnion(TNull(), TNonNegativeFiniteNumber()),
    observable: TBoolean(),
  }),
});

// policy.protectedSeats의 선언 -- ★P1-1이 발생했던 자리. 2R은 여기를
// `Array.isArray(p.protectedSeats)`로만 짰다(그릇만 보고 내용물은 안
// 봄). 3R은 원소 타입을 TArrayOf(TNonEmptyString())로 선언한다 --
// `[null]`·`[1]`·`[{}]`·`['other', null]`은 원소 중 하나라도
// TNonEmptyString을 통과 못 하면 배열 전체가 무효가 되어 fail-closed
// PROTECTED_LIST_INVALID로 접힌다.
const PROTECTED_SEATS_SCHEMA = TArrayOf(TNonEmptyString());

// 스키마 결손/타입 오류를 여기서 전부 잡는다(fail-closed 진입점) -- 이
// 함수가 false를 내면 judgeSeatReclaim은 나머지 로직을 평가하지 않고
// 곧장 UNOBSERVABLE을 반환한다(teardown-core.mjs의 isValidInventoryShape와
// 동형 원칙).
function isValidSeatInventoryShape(inventory) {
  return SEAT_INVENTORY_SCHEMA.check(inventory);
}

function buildSeatEvidence(inventory, ruleId, extra = {}) {
  return {
    ruleId,
    dispatch: inventory.dispatch,
    activity: inventory.activity,
    ...extra,
  };
}

// classifyProtection -- §2⑴ 규칙의 두 번째 파생, 3R에서 PROTECTED_SEATS_SCHEMA
// 선언으로 이관: `protectedSeats`가 배열이 아니거나(결손·문자열·기타
// 타입) 배열이어도 **원소 중 하나라도** 비어있지 않은 문자열이 아니면
// (P1-1: `[null]`·`[1]`·`[{}]` 등) "보호 목록을 못 읽는다"는 뜻이므로
// "보호 목록이 비어 있다"(=열려 있다)로 조용히 바꿔치기하지 않는다 --
// 못 읽으면 안전측인 PROTECTED로 접는다. 스키마를 통과하면(빈 배열
// 포함) exact match만 본다(부분일치·정규식 금지 -- teardown-core.mjs
// isProtectedTarget과 동일 정책).
function classifyProtection(inventory, p) {
  if (!PROTECTED_SEATS_SCHEMA.check(p.protectedSeats)) {
    return {
      eligibility: SEAT_ELIGIBILITY.PROTECTED,
      reason: SEAT_REASON.PROTECTED_LIST_INVALID,
      evidence: buildSeatEvidence(
        inventory,
        SEAT_REASON.PROTECTED_LIST_INVALID,
        { protectedSeats: p.protectedSeats ?? null },
      ),
    };
  }
  // HYK-436: 위 TArrayOf와 동형 -- p.protectedSeats 자신의 includes를
  // 부르지 않는다(재정의되면 보호가 사라진다, 검토 4R 실증: IncludesBypass
  // -> ['pane-1']이 보호 대조를 우회). 원형의 원본 includes를 빌려 쓴다.
  if (Array.prototype.includes.call(p.protectedSeats, inventory.seat.paneKey)) {
    return {
      eligibility: SEAT_ELIGIBILITY.PROTECTED,
      reason: SEAT_REASON.PROTECTED_SEAT,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.PROTECTED_SEAT, {
        protectedSeats: p.protectedSeats,
      }),
    };
  }
  return null;
}

// classifyDispatchStage -- §2⑵ 이분 축 + §2⑴/§2⑷ 파생: completedAt이
// null이면 "아직 안 끝났다"(그 값이 무엇이든 하나로 접힌다, status
// 문자열은 아예 안 본다). null이 아니면 이 시점에서 이미
// isValidDispatchField가 "파싱 가능"함을 보장했으므로, 남은 유일한
// 검사는 "그 시각이 `nowMs`를 넘지 않는가"뿐이다(미래 completedAt은
// "끝났다"는 증거로 신뢰하지 않는다).
function classifyDispatchStage(inventory, nowMs) {
  if (inventory.dispatch.observable !== true) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reason: SEAT_REASON.DISPATCH_UNOBSERVABLE,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.DISPATCH_UNOBSERVABLE),
    };
  }
  if (inventory.dispatch.completedAt === null) {
    return {
      eligibility: SEAT_ELIGIBILITY.DISPATCH_ACTIVE,
      reason: SEAT_REASON.DISPATCH_ACTIVE,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.DISPATCH_ACTIVE),
    };
  }
  if (Date.parse(inventory.dispatch.completedAt) > nowMs) {
    return {
      eligibility: SEAT_ELIGIBILITY.DISPATCH_ACTIVE,
      reason: SEAT_REASON.DISPATCH_COMPLETED_AT_FUTURE,
      evidence: buildSeatEvidence(
        inventory,
        SEAT_REASON.DISPATCH_COMPLETED_AT_FUTURE,
        { nowMs },
      ),
    };
  }
  return null;
}

// classifyActivityStage -- §2⑴ 파생: `idleMs === null`인데
// `observable === true`인 것은 모순 입력("관측 가능한데 값을 모른다")
// 이므로, 그 모순을 숫자 비교의 암묵적 coercion에 맡기지 않고 "idle
// 시간을 모른다"를 명시적으로 유예 구간(fail-closed)에 접는다.
function classifyActivityStage(inventory, p) {
  if (inventory.activity.observable !== true) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reason: SEAT_REASON.ACTIVITY_UNOBSERVABLE,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.ACTIVITY_UNOBSERVABLE),
    };
  }
  if (inventory.activity.idleMs === null) {
    return {
      eligibility: SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD,
      reason: SEAT_REASON.ACTIVITY_IDLE_UNKNOWN,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.ACTIVITY_IDLE_UNKNOWN),
    };
  }
  // 유예 구간(§2⑸): worker_done 뒤에도 사용자가 이 터미널에 직접 새 일을
  // 시킬 수 있다(이 좌석 자신의 시스템 프롬프트 "AFTER YOU SEND
  // worker_done" 절 참조) -- 배차가 끝났다는 사실만으로 곧장 회수하면 그
  // 진행 중인 사용자-지시 작업을 죽인다. minIdleMs가 숫자가 아니면(정책
  // 결손) 유예를 무한으로 취급한다 -- fail-closed(회수 금지 쪽으로 접는다).
  const minIdleMs =
    Number.isFinite(p.minIdleMs) && p.minIdleMs >= 0 ? p.minIdleMs : Infinity;
  if (inventory.activity.idleMs < minIdleMs) {
    return {
      eligibility: SEAT_ELIGIBILITY.WITHIN_GRACE_PERIOD,
      reason: SEAT_REASON.WITHIN_GRACE_PERIOD,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.WITHIN_GRACE_PERIOD, {
        minIdleMs: p.minIdleMs,
      }),
    };
  }
  return null;
}

// classifySeatEligibility -- judgeSeatReclaim에서 분리(quality-check
// 복잡도 상한 12 준수, teardown-core.mjs의 classifyEligibility와 동형
// 분리 원칙). 스키마 검사는 호출자(judgeSeatReclaim)가 이미 통과시킨
// 뒤에만 이 함수가 불린다 -- 여기서는 inventory 필드 존재를 가정한다.
// 단계별 분리(classifyProtection/classifyDispatchStage/
// classifyActivityStage)는 §2⑴ 규칙의 필드별 파생을 그대로 함수 경계로
// 옮긴 것뿐이다 -- 검토자가 낸 반례를 하나씩 막으려고 나눈 게 아니다.
function classifySeatEligibility(inventory, p, nowMs) {
  if (inventory.seat.paneKey === null) {
    return {
      eligibility: SEAT_ELIGIBILITY.TARGET_UNIDENTIFIED,
      reason: SEAT_REASON.TARGET_UNIDENTIFIED,
      evidence: buildSeatEvidence(inventory, SEAT_REASON.TARGET_UNIDENTIFIED),
    };
  }

  const protection = classifyProtection(inventory, p);
  if (protection) return protection;

  const dispatchStage = classifyDispatchStage(inventory, nowMs);
  if (dispatchStage) return dispatchStage;

  const activityStage = classifyActivityStage(inventory, p);
  if (activityStage) return activityStage;

  return {
    eligibility: SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE,
    reason: SEAT_REASON.ELIGIBLE,
    evidence: buildSeatEvidence(inventory, SEAT_REASON.ELIGIBLE),
  };
}

// judgeSeatReclaim({ inventory, policy, nowMs }) -- policy: { protectedSeats:
// string[], minIdleMs: number }. `nowMs`: 판정 기준 시각(호출자가 주입,
// §2⑷). 순수 판정, 부작용 0, 어떤 인자에도 throw하지 않는다(§1-3). 반환:
// { eligibility, reclaimEligible, reason, evidence }.
export function judgeSeatReclaim(args) {
  // ★ 신뢰 경계(6R): 인자를 여기서 단 한 번 읽어 고정한다. 아래는 전부
  // 그 고정본만 본다.
  const fixed = snapshotPlainData(args);
  if (!fixed.ok) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reclaimEligible: false,
      reason: SEAT_REASON.SCHEMA_INVALID,
      evidence: {
        ruleId: SEAT_REASON.SCHEMA_INVALID,
        inventory: null,
        nowMs: null,
        snapshotReason: fixed.reason,
      },
    };
  }
  const { inventory, policy, nowMs } = isPlainObject(fixed.value)
    ? fixed.value
    : {};
  const p = isPlainObject(policy) ? policy : {};

  if (!isValidSeatInventoryShape(inventory)) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reclaimEligible: false,
      reason: SEAT_REASON.SCHEMA_INVALID,
      evidence: {
        ruleId: SEAT_REASON.SCHEMA_INVALID,
        inventory: inventory ?? null,
        nowMs: Number.isFinite(nowMs) ? nowMs : null,
      },
    };
  }
  if (!Number.isFinite(nowMs)) {
    return {
      eligibility: SEAT_ELIGIBILITY.UNOBSERVABLE,
      reclaimEligible: false,
      reason: SEAT_REASON.NOW_MS_INVALID,
      evidence: {
        ruleId: SEAT_REASON.NOW_MS_INVALID,
        inventory: inventory ?? null,
        nowMs: null,
      },
    };
  }

  const { eligibility, reason, evidence } = classifySeatEligibility(
    inventory,
    p,
    nowMs,
  );
  return {
    eligibility,
    reclaimEligible: eligibility === SEAT_ELIGIBILITY.RECLAIM_ELIGIBLE,
    reason,
    evidence,
  };
}

function isValidAnomalyInput(eligibleUnreclaimedCount, systemPressure, policy) {
  if (
    !Number.isInteger(eligibleUnreclaimedCount) ||
    eligibleUnreclaimedCount < 0
  )
    return false;
  if (!isPlainObject(systemPressure)) return false;
  if (typeof systemPressure.observable !== "boolean") return false;
  if (
    systemPressure.availableMemoryBytes !== null &&
    !(
      Number.isFinite(systemPressure.availableMemoryBytes) &&
      systemPressure.availableMemoryBytes >= 0
    )
  )
    return false;
  if (!isPlainObject(policy)) return false;
  if (!Number.isFinite(policy.memoryFloorBytes) || policy.memoryFloorBytes < 0)
    return false;
  return true;
}

// judgeReclaimAnomaly({ eligibleUnreclaimedCount, systemPressure }, policy)
// -- coder-task.md §2⑶: "회수 누락이 이상으로 열리는가"의 관측 축.
// policy: { memoryFloorBytes: number }. 순수 판정, 부작용 0, 어떤 인자에도
// throw하지 않는다(§1-3).
//
// 좌석 "개수" 단독으로는 절대 ANOMALY까지 올라가지 않는다(비타협, §2⑶) --
// count>0은 최대 WATCH까지만 올린다. ANOMALY는 반드시 가용 메모리 축이
// 관여해야 뜬다(바닥 이하, 또는 관측 자체가 안 됨).
//
// 입력이 무효하거나(스키마 결손) 메모리를 관측할 수 없는 상태에서
// count>0이면 **ANOMALY 쪽으로 접는다**(fail-open, judgeSeatReclaim의
// fail-closed와 방향이 다르다 -- 의도적 비대칭, coder-task.md §2⑸에서
// 근거 설명: 이 축의 유일한 산출물은 "사람에게 보이는 신호"이지 파괴
// 행위가 아니다. 잘못 띄운 ANOMALY의 대가는 사람이 30초 들여다보고
// 마는 것이고, 조용히 숨긴 ANOMALY의 대가는 §1 실측 그대로 -- 밤새 러너
// 46% 빨강·1.5시간 손실이다. 두 대가가 비대칭이므로 관측 실패는 침묵이
// 아니라 신호 쪽으로 접는다). 이 비대칭은 2R에서도 그대로 유지한다
// (coder-task.md §3-4 비타협).
export function judgeReclaimAnomaly(args, policy) {
  // ★ 신뢰 경계(6R): 두 인자를 한 번에 고정한다. 고정 자체가 실패하면 이
  // 축의 비대칭 방향(fail-open -- 아래 근거 주석)에 맞춰 ANOMALY로 접는다.
  const fixed = snapshotPlainData({ args, policy });
  if (!fixed.ok) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.INPUT_INVALID,
      evidence: {
        ruleId: ANOMALY_REASON.INPUT_INVALID,
        eligibleUnreclaimedCount: null,
        systemPressure: null,
        snapshotReason: fixed.reason,
      },
    };
  }
  const { eligibleUnreclaimedCount, systemPressure } = isPlainObject(
    fixed.value.args,
  )
    ? fixed.value.args
    : {};
  const p = isPlainObject(fixed.value.policy) ? fixed.value.policy : {};
  if (!isValidAnomalyInput(eligibleUnreclaimedCount, systemPressure, p)) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.INPUT_INVALID,
      evidence: {
        ruleId: ANOMALY_REASON.INPUT_INVALID,
        eligibleUnreclaimedCount: eligibleUnreclaimedCount ?? null,
        systemPressure: systemPressure ?? null,
      },
    };
  }

  if (eligibleUnreclaimedCount === 0) {
    return {
      status: ANOMALY_STATUS.OK,
      reason: ANOMALY_REASON.NO_BACKLOG,
      evidence: { ruleId: ANOMALY_REASON.NO_BACKLOG, eligibleUnreclaimedCount },
    };
  }

  if (systemPressure.observable !== true) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.BACKLOG_MEMORY_UNOBSERVABLE,
      evidence: {
        ruleId: ANOMALY_REASON.BACKLOG_MEMORY_UNOBSERVABLE,
        eligibleUnreclaimedCount,
      },
    };
  }

  if (systemPressure.availableMemoryBytes < p.memoryFloorBytes) {
    return {
      status: ANOMALY_STATUS.ANOMALY,
      reason: ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR,
      evidence: {
        ruleId: ANOMALY_REASON.BACKLOG_MEMORY_BELOW_FLOOR,
        eligibleUnreclaimedCount,
        availableMemoryBytes: systemPressure.availableMemoryBytes,
        memoryFloorBytes: p.memoryFloorBytes,
      },
    };
  }

  return {
    status: ANOMALY_STATUS.WATCH,
    reason: ANOMALY_REASON.BACKLOG_MEMORY_OK,
    evidence: {
      ruleId: ANOMALY_REASON.BACKLOG_MEMORY_OK,
      eligibleUnreclaimedCount,
      availableMemoryBytes: systemPressure.availableMemoryBytes,
      memoryFloorBytes: p.memoryFloorBytes,
    },
  };
}
