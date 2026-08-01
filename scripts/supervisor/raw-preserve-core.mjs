// HYK-183 C-2 (coder-task.md §5, SV-8 전반부) -- "원시 생성 응답 보존"
// 판정 코어.
//
// 배경(coder-task.md §1): SV-8 = "원시 생성 응답이 가공 전 형태로
// 보존되고, 소비 시 `terminal show`x`dispatch-show` 독립 재조회 join".
// 이 코어는 그 앞부분(C-2)만 맡는다 -- 좌석을 만들 때 받은 생성 응답을
// "가공 전 형태"로 보존했는지 판정한다. 뒷부분(C-3, 독립 재조회 join)은
// 이 파일에 없다.
//
// 이 계약이 보장하지 않는 것 / 정하지 않는 것 (S11 필수):
// - 이 코어는 원시 기록이 진짜 벤더 응답에서 왔는지를 증명하지 않는다.
//   주어진 기록이 "가공 전 형태를 유지하는가"만 판정한다.
// - 저장 위치.형식은 이 조각이 정하지 않는다 -- `preserved`는 호출자가
//   이미 어디선가 읽어 온 값을 그대로 주입한다(이 코어는 파일을 읽지
//   않는다).
// - 이 기록은 우리와 같은 신뢰 도메인 안에 있다 -- 외부 append-only.OS
//   앵커가 붙어 있지 않다. 따라서 이 판정은 "기록이 그 형태를 유지하는가"
//   까지이며 그 이상을 주장하지 않는다(coder-task.md §10 P2 정정 -- 이전
//   판본의 문구가 금지어를 포함해 이렇게 바꿨다).
// - 독립 재조회 join은 C-3이며 여기 없다 -- `terminal show`.
//   `dispatch-show`를 다시 호출해 대조하는 코드는 이 파일에 한 줄도
//   없다.
//
// 어휘 신규 도입 선언(coder-task.md §10 (d') -- freeze 계약 대조):
// `seat-proof-contract-v1.mjs`는 "좌석 증명"(그 좌석이 그 배정을 받은
// 좌석인가) 어휘만 고정한다(`SEAT_PROOF`=PROVEN/UNPROVEN,
// `SEAT_PROOF_REASON`=DISPATCH_SHOW_INVALID 등 8종) -- "원시 보존 상태"
// (기록이 없다.읽을 수 없다.구조가 다르다.가공 흔적이 있다)를 담는 어휘가
// 계약에 없다. 그래서 아래 `RAW_PRESERVATION_REASON`은 이 조각이 새로
// 도입한 것이다(말없이 지어낸 것이 아니라 이 헤더로 선언한다). 계약의
// `NEGATIVE_CONTROLS`에 이름이 비슷한 두 항목(`RECORD_TAMPERED`,
// `RECORD_FIELD_MISSING`)이 있지만, 그 둘은 재사용하지 않았다 -- 아래
// `RAW_PRESERVATION_REASON` 선언부 주석에 이유를 적었다.
//
// 비타협(coder-task.md §2):
// - I/O 0 -- fs.child_process.네트워크 호출 전부 금지. import는 없다(외부
//   모듈을 참조하지 않으므로 이 파일 자신이 구조적으로 I/O 표면이 없다).
//   `expected`로 넘기는 필드 맵은 호출자가 `seat-proof-contract-v1.mjs`의
//   값을 그대로 가져다 쓴다 -- 이 파일은 그 계약을 import하지 않는다(결합
//   최소화, §2-6 "freeze 계약을 고치지 마라"와 무관하게 이 코어는 읽기조차
//   하지 않는다).
// - throw로 판정을 대신하지 않는다 -- 인자.기록이 무엇이든 예외 없이
//   `{ok, verdict, reasonCode}`를 반환한다.
// - "기록 없음"을 "괜찮음"으로 해석하지 않는다 -- 기록 없음.읽기 불가.
//   구조 불일치.가공 흔적 전부 `NOT_PRESERVED`이다. `PRESERVED`는 "가공
//   전 형태가 명시적으로 확인된 경우"에만 나온다.

export const RAW_PRESERVATION_VERDICT = Object.freeze({
  PRESERVED: "PRESERVED",
  NOT_PRESERVED: "NOT_PRESERVED",
});

// 신규 도입(위 헤더 참조) -- seat-proof-contract-v1.mjs에 "원시 보존 상태"
// 어휘가 없어 이 조각이 만들었다. `NEGATIVE_CONTROLS`의 `RECORD_TAMPERED`
// (seat-registry.mjs의 registry 파일이 JSON으로도 파싱되지 않는 경우 --
// `parseRegistryText`의 `corrupt-json`)와 `RECORD_FIELD_MISSING`
// (파싱은 되지만 `schemaVersion`.`seats` 배열 같은 registry 고유 스키마가
// 결손된 경우 -- `schema-mismatch`)은 재사용하지 않는다: 그 둘은
// seat-registry.mjs 하나의 구체적 파일 스키마(registry)에 매인 attack-
// catalog 이름이지, 이 코어처럼 "호출자가 임의로 주입하는 `expected`
// 필드.타입 맵" 전반에 쓰는 이식 가능한 상수로 계약에 export돼 있지 않다
// (`seat-registry.mjs`는 그 이름들을 reasonCode로 반환조차 하지 않고
// `"corrupt-json"`.`"schema-mismatch"` 문자열을 쓴다 -- `RECORD_TAMPERED`.
// `RECORD_FIELD_MISSING`은 계약의 서술용 카탈로그 id일 뿐이다). 여기서
// 그 이름을 빌리면 "이 코어가 registry 스키마를 검사한다"는 잘못된
// 인상을 준다. 그래서 `RAW_UNREADABLE`.`RAW_SHAPE_MISMATCH`를 그대로
// 유지했다.
export const RAW_PRESERVATION_REASON = Object.freeze({
  RAW_OK: "RAW_OK",
  RAW_MISSING: "RAW_MISSING",
  RAW_UNREADABLE: "RAW_UNREADABLE",
  RAW_SHAPE_MISMATCH: "RAW_SHAPE_MISMATCH",
  RAW_NORMALIZED: "RAW_NORMALIZED",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
});

const ALLOWED_FIELD_TYPES = Object.freeze(["string", "number", "boolean"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// `expected`는 seat-proof-contract-v1.mjs의 `*_RAW_FIELD_TYPES` 맵(예:
// TERMINAL_SHOW_RAW_FIELD_TYPES, DISPATCH_SHOW_RAW_FIELD_TYPES)을 호출자가
// 그대로 넘기는 형태를 신뢰한다 -- {필드명: "string"|"number"|"boolean"}
// 형태의 non-empty plain object여야 한다.
function isValidExpectedFieldMap(expected) {
  if (!isPlainObject(expected)) return false;
  const keys = Object.keys(expected);
  if (keys.length === 0) return false;
  return keys.every((k) => ALLOWED_FIELD_TYPES.includes(expected[k]));
}

function invalid() {
  return {
    ok: false,
    verdict: RAW_PRESERVATION_VERDICT.NOT_PRESERVED,
    reasonCode: RAW_PRESERVATION_REASON.INVALID_ARGUMENTS,
  };
}

function notPreserved(reasonCode) {
  return {
    ok: true,
    verdict: RAW_PRESERVATION_VERDICT.NOT_PRESERVED,
    reasonCode,
  };
}

function preservedOk() {
  return {
    ok: true,
    verdict: RAW_PRESERVATION_VERDICT.PRESERVED,
    reasonCode: RAW_PRESERVATION_REASON.RAW_OK,
  };
}

// "기록 없음" -- 아예 주어지지 않았거나, 문자열이 아니거나(가공 전 텍스트
// 형태가 아니므로 판정 대상 자체가 없음), 빈 문자열.
function isMissingRawText(preserved) {
  return (
    preserved === undefined ||
    preserved === null ||
    typeof preserved !== "string" ||
    preserved.length === 0
  );
}

// preserved(가공 전 텍스트)를 파싱해 {ok, parsed} 또는 {ok:false,
// reasonCode}를 반환한다. "JSON 아님"·"구조 불일치"(최상위가 plain
// object가 아님) 둘 다 여기서 갈라진다.
function parseRawText(preserved) {
  let parsed;
  try {
    parsed = JSON.parse(preserved);
  } catch {
    return { ok: false, reasonCode: RAW_PRESERVATION_REASON.RAW_UNREADABLE };
  }
  if (!isPlainObject(parsed)) {
    return {
      ok: false,
      reasonCode: RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH,
    };
  }
  return { ok: true, parsed };
}

// "가공 흔적" -- 원본에 없던 키가 있거나(우리 쪽이 필드를 덧붙임) 원본
// 키가 사라짐(우리 쪽이 필드를 떨어뜨림). expected가 고정한 키 집합과
// 정확히 같아야 한다(부분집합.초과집합 둘 다 거부). 키 집합이 같다면
// "필드 결손"의 나머지 절반(값 타입)도 확인한다.
function checkShapeAgainstExpected(parsed, expected) {
  const expectedKeys = Object.keys(expected).sort();
  const parsedKeys = Object.keys(parsed).sort();
  if (JSON.stringify(parsedKeys) !== JSON.stringify(expectedKeys)) {
    return RAW_PRESERVATION_REASON.RAW_NORMALIZED;
  }
  for (const key of expectedKeys) {
    if (typeof parsed[key] !== expected[key]) {
      return RAW_PRESERVATION_REASON.RAW_SHAPE_MISMATCH;
    }
  }
  return null;
}

// judgeRawPreservation({preserved, expected, now}) -> {ok, verdict, reasonCode}
//
// preserved = 보존된 원시 기록 그 자체(주입 -- 이 코어가 파일에서 읽지
// 않는다). "가공 전 형태"의 최소 요건으로, 캡처된 그대로의 JSON 텍스트
// 문자열을 기대한다(파싱된 객체를 직접 넘기면 그 객체가 우리 쪽에서 이미
// 한 번이라도 손을 탄 것인지 이 코어가 구분할 수 없으므로 받지 않는다).
// expected = 무엇이 보존돼 있어야 하는가 -- seat-proof-contract-v1.mjs가
// 고정한 필드명.타입 맵을 그대로 넘긴다.
export function judgeRawPreservation(args) {
  if (!isPlainObject(args)) return invalid();
  const { preserved, expected, now } = args;
  if (!isFiniteNumber(now)) return invalid();
  if (!isValidExpectedFieldMap(expected)) return invalid();

  if (isMissingRawText(preserved)) {
    return notPreserved(RAW_PRESERVATION_REASON.RAW_MISSING);
  }

  const parseResult = parseRawText(preserved);
  if (!parseResult.ok) {
    return notPreserved(parseResult.reasonCode);
  }

  const shapeReason = checkShapeAgainstExpected(parseResult.parsed, expected);
  if (shapeReason !== null) {
    return notPreserved(shapeReason);
  }

  return preservedOk();
}
