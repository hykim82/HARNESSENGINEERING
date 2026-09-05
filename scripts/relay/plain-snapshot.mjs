// HYK-431 6R / HYK-436 -- 신뢰 경계에서 입력을 "평범한 자료"로 고정하는
// 단일 지점(coder-task.md §2-2).
//
// ---- 왜 이 파일이 생겼는가 (1R~5R이 수렴하지 못한 이유) ----
//
// 1R은 값 형상을, 2R은 배열 원소를, 3R은 "입력이 검사 자체를 조종하는 것"을,
// 4R은 "입력 자신의 메서드 재정의"를, 5R은 원형 메서드 차용을 닫았다. 매
// 라운드가 **그때 관측된 형태**를 닫았고 매번 다음 형태가 나왔다. 다섯
// 형태의 공통 뿌리는 하나다:
//
//   ★ 「검증기」와 「소비자」가 **신뢰할 수 없는 같은 객체를 각자 따로
//     읽는다**. 그래서 그 객체는 두 독자에게 서로 다른 것을 보여줄 수 있다.
//
// 5R의 `Array.prototype.every.call(v, ...)`은 "v가 무엇을 재정의했든 순회
// 로직은 원형 것"까지는 고쳤지만, 그 순회가 **읽는 값**(`v.length`,
// `v[i]`)은 여전히 v가 매 호출마다 새로 정한다. 검토 6R은 정확히 그
// 틈으로 들어왔다: `Array.isArray(proxy)===true`인 Proxy가 `length`를 1로
// 보고해 실제 원소 `["<유효 해시>", null]` 중 `null`을 검증기에게서 숨기고,
// 그 뒤 소비 경로의 두 번째 `.length`/인덱스 순회에는 다른 것을 보여줬다.
//
// ---- 이 파일이 요구하는 성질 (⒜⒝⒞) ----
//
// ⒜ **관측은 한 번뿐**: 아래 traversal은 입력의 각 지점(배열의 length,
//    각 인덱스, 객체의 키 집합, 각 키의 값)을 **정확히 한 번만** 읽는다.
//    그 뒤 판정 경로는 원본을 다시 만지지 않는다 -- 원본이 호출마다 다른
//    값을 주더라도 판정에 관여할 두 번째 기회가 구조적으로 없다(TOCTOU
//    소멸).
// ⒝ **검증기와 소비자가 같은 물건을 본다**: 산출물은 원본과 분리된 새
//    자료다. 호출자는 이 산출물 하나만 아래로 흘려보내므로, 검증을 통과한
//    그 값이 **그대로** 소비된다.
// ⒞ **고정본에는 흔들 수 있는 것이 남지 않는다**: 산출물의 노드는 전부
//    `Object.freeze`된 순정 배열/객체이며(프로토타입은 이 파일이 만든
//    리터럴의 것이지 입력의 것이 아니다), 값은 전부 원시값이다. getter도,
//    Proxy도, 재정의된 메서드도 고정 이후에는 관여할 자리가 없다.
//
// ---- "복사"만으로는 부족한 자리 -- 명시적 거부와의 조합 ----
//
// 복사는 "두 독자가 다른 것을 본다"를 없애지만, **한 번의 거짓말**까지
// 없애지는 못한다: `length`를 0으로 보고하는 Proxy를 한 번만 읽으면 우리는
// 그 거짓말을 성실히 베껴 담을 뿐이다(보호 목록을 통째로 숨기는 공격이
// 정확히 이 형태다). 그래서 이 파일은 두 가지를 **함께** 한다(coder-task.md
// §2-2가 명시적으로 허용하는 "둘의 조합"):
//
//   (1) **명시적 거부** -- `util.types.isProxy`로 Proxy를 식별해 아예
//       받지 않는다. Proxy는 "읽는 사람마다 다른 얼굴을 보여줄 수 있는
//       운반체" 그 자체이므로, 자료로 고정하기 전에 거부한다.
//   (2) 그 뒤에야 (1)을 통과한 것을 **한 번 읽어 평범한 자료로 복사**하고
//       얼린다.
//
// ★왜 (1)이 "또 한 형태를 막는 것"이 아닌가: `length`를 위조해 원소를
// 숨기는 짓은 **순정 Array로는 원리적으로 불가능하다** -- Array의
// `length`는 언어 불변식이라 값을 줄이면 그 밖의 원소가 실제로 지워진다
// (`Object.defineProperty(arr,'length',{value:1})`도 마찬가지다. 아래
// plain-snapshot.test.mjs가 이 사실 자체를 시험으로 고정한다). 즉
// `Array.isArray(v)===true`이면서 자기 원소를 감출 수 있는 운반체는
// **Proxy 하나뿐**이다. 그래서 (1)은 "관측된 공격 한 형태"가 아니라
// "그 형태가 존재할 수 있는 유일한 운반체 부류"를 닫는다. 그리고 Proxy를
// 통과시키더라도 (2)의 단일 관측 때문에 검증기와 소비자는 여전히 같은
// 값을 보게 된다 -- 두 층은 서로 다른 실패를 덮는다.
//
// ⚠️ 정직 한계(등급: 확실): `util.types.isProxy`는 V8 수준 식별이라
// 회피 수단이 JS 코드에 없다. 그러나 **Proxy가 아니면서** 자기 자신에
// 대해 완전히 일관된 거짓말을 하는 값(예: 애초에 짧은 진짜 배열)은 이
// 파일이 구별할 수 없다 -- 그건 이미 "그 평범한 자료 자체"이고, 우리는
// 정확히 그 자료로 판정한다(⒝는 성립한다). "그 자료가 사실과 맞는가"는
// 이 경계 밖(자료를 만든 상위 계약)의 몫이다.

import { types } from "node:util";

export const PLAIN_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 12,
  maxNodes: 8192,
});

function fail(reason) {
  return { ok: false, reason, value: undefined };
}

function errText(err) {
  try {
    if (err && typeof err === "object" && typeof err.message === "string") {
      return err.message;
    }
    return String(err);
  } catch {
    return "unknown error (message accessor threw)";
  }
}

// 원시값 -- 그 자체가 이미 "흔들 수 없는" 자료다(문자열 위장 객체는
// typeof가 "object"라 여기 들어오지 못한다).
function isPlainPrimitive(v) {
  const t = typeof v;
  return (
    v === null ||
    t === "string" ||
    t === "number" ||
    t === "boolean" ||
    t === "undefined"
  );
}

function snapshotArray(v, ctx, depth) {
  const len = v.length; // ★ length 관측은 여기 이 한 번뿐이다(⒜).
  if (!Number.isSafeInteger(len) || len < 0) {
    return fail(`array length is not a safe non-negative integer (${len})`);
  }
  const out = [];
  for (let i = 0; i < len; i++) {
    const child = snapshotNode(v[i], ctx, depth + 1); // ★ 인덱스마다 한 번.
    if (!child.ok) return child;
    out.push(child.value);
  }
  return { ok: true, value: Object.freeze(out), reason: null };
}

function snapshotObject(v, ctx, depth) {
  const out = {};
  for (const key of Object.keys(v)) {
    const child = snapshotNode(v[key], ctx, depth + 1); // ★ 키마다 한 번.
    if (!child.ok) return child;
    // 대입(`out[key] = ...`)이 아니라 defineProperty로 심는다 -- `__proto__`
    // 같은 키가 setter를 타고 산출물의 프로토타입을 바꾸는 길을 아예
    // 막는다(⒞).
    Object.defineProperty(out, key, {
      value: child.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return { ok: true, value: Object.freeze(out), reason: null };
}

function snapshotNode(v, ctx, depth) {
  if (ctx.remaining <= 0) {
    return fail(`input exceeds the ${ctx.maxNodes}-node snapshot budget`);
  }
  ctx.remaining -= 1;
  if (isPlainPrimitive(v)) return { ok: true, value: v, reason: null };
  if (typeof v !== "object") {
    return fail(`a value of type '${typeof v}' is not plain data`);
  }
  if (types.isProxy(v)) {
    return fail(
      "input contains a Proxy -- a Proxy can show different values to " +
        "different readers, so it is refused before it can be fixed as data",
    );
  }
  if (depth >= ctx.maxDepth) {
    return fail(`input nests deeper than the ${ctx.maxDepth}-level limit`);
  }
  return Array.isArray(v)
    ? snapshotArray(v, ctx, depth)
    : snapshotObject(v, ctx, depth);
}

// snapshotPlainData(value, limits) -> { ok, value, reason }
//
// 성공하면 `value`는 원본과 완전히 분리된, 깊게 얼린 평범한 자료다.
// 실패하면 `ok:false`와 사람이 읽을 수 있는 `reason`이다 -- 호출자는
// **반드시 fail-closed로 접어야 한다**(이 파일은 판정을 대신하지 않는다).
// 어떤 인자에도 throw하지 않는다(이 저장소 순수 코어 관례) -- 입력의
// getter가 던지면 그 사실을 실패 사유로 바꿔 돌려준다.
export function snapshotPlainData(value, limits) {
  const l = limits !== null && typeof limits === "object" ? limits : {};
  const maxDepth = Number.isSafeInteger(l.maxDepth)
    ? l.maxDepth
    : PLAIN_SNAPSHOT_LIMITS.maxDepth;
  const maxNodes = Number.isSafeInteger(l.maxNodes)
    ? l.maxNodes
    : PLAIN_SNAPSHOT_LIMITS.maxNodes;
  const ctx = { remaining: maxNodes, maxNodes, maxDepth };
  try {
    return snapshotNode(value, ctx, 0);
  } catch (err) {
    return fail(`reading the input threw (${errText(err)})`);
  }
}
