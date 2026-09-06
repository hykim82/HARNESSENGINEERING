import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotPlainData } from "./plain-snapshot.mjs";

// HYK-447 1R (HYK-431 6R 계승) -- 신뢰 경계 고정기(plain-snapshot.mjs)의
// 단위 계약. 여기서 재는 것은 세 성질이다(coder-task.md §2-1 ⒜⒝⒞):
//   ⒜ 평범한 자료가 아닌 값은 접히지 않고 **거부**된다(fail-closed)
//   ⒝ 관찰은 입력 **전체**에 대해 한 시점이다 -- 순회 도중 입력의 코드가
//      돌 수 없으므로 형제를 바꿔치기할 틈이 없다
//   ⒞ 산출물은 원본과 분리돼 깊게 얼어 있다
//
// ⚠️ 6R과 달라진 점: 접근자(getter)는 "정확히 한 번 읽는" 대상이 아니라
// **거부** 대상이다. 한 번이라도 부르면 그 한 번 안에서 형제가 바뀌기
// 때문이다(검토 7R P1-ⓑ가 정확히 그렇게 뚫었다).

test("plain-snapshot ⒜: 접근자(getter)를 가진 입력은 거부된다 -- 그리고 그 getter는 **한 번도** 불리지 않는다", () => {
  let reads = 0;
  const input = {
    get volatile() {
      reads += 1;
      return `read-${reads}`;
    },
  };
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /accessor property \('volatile'\)/);
  assert.equal(reads, 0, "거부는 값을 꺼내기 전에 일어나야 한다");
});

test("plain-snapshot ⒜: 배열 원소가 접근자여도 거부되고 불리지 않는다", () => {
  let reads = 0;
  const arr = ["placeholder"];
  Object.defineProperty(arr, 0, {
    get() {
      reads += 1;
      return `el-${reads}`;
    },
    enumerable: true,
    configurable: true,
  });
  const fixed = snapshotPlainData({ arr });
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /accessor property \('0'\)/);
  assert.equal(reads, 0);
});

// ★⒝의 핵심 시험 -- 검토 7R P1-ⓑ 그 자체다. getter가 읽히는 순간 아직
// 읽지 않은 **형제**를 비우는 입력을 넣는다. 6R 경계는 이것을 성실히
// 실행해 "비워진 뒤의 형제"를 고정했다(보호 목록이 사라졌다). 지금은
// getter를 부르지 않으므로 형제가 바뀔 수 없고, 입력 전체가 거부된다.
test("plain-snapshot ⒝: 굳히는 도중 형제를 비우는 입력 -- 형제는 그대로이고 입력은 거부된다", () => {
  const input = {
    policy: { protectedSeats: ["pane-1"] },
    inventory: {},
  };
  Object.defineProperty(input.inventory, "paneKey", {
    get() {
      input.policy.protectedSeats.length = 0; // 형제를 비운다
      return "pane-1";
    },
    enumerable: true,
    configurable: true,
  });

  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /accessor property \('paneKey'\)/);
  assert.deepEqual(
    input.policy.protectedSeats,
    ["pane-1"],
    "순회가 입력의 코드를 전혀 돌리지 않으므로 형제는 변할 수 없다",
  );
});

test("plain-snapshot ⒜: 평범한 자료가 아닌 값은 {}로 접히지 않고 거부된다(Date/Map/Set/RegExp/Error/클래스 인스턴스)", () => {
  class Custom {
    constructor() {
      this.x = 1;
    }
  }
  const cases = [
    new Date("2026-09-06T00:00:00.000Z"),
    new Map([["k", "v"]]),
    new Set(["a"]),
    /re/g,
    new Error("boom"),
    new Custom(),
  ];
  for (const bad of cases) {
    const top = snapshotPlainData(bad);
    assert.equal(top.ok, false, String(bad));
    assert.match(top.reason, /not plain data|prototype/);
    // 정책 자리(중첩)에 들어가도 마찬가지다 -- 이게 7R P1-ⓐ의 harm path다.
    const nested = snapshotPlainData({ policy: { protectedTargets: bad } });
    assert.equal(nested.ok, false, String(bad));
  }
});

test("plain-snapshot ⒜: null 프로토타입 객체는 평범한 자료다(통과), 임의 프로토타입 객체는 아니다(거부)", () => {
  const bare = Object.create(null);
  bare.k = "v";
  const okFixed = snapshotPlainData(bare);
  assert.equal(okFixed.ok, true, okFixed.reason);
  assert.equal(okFixed.value.k, "v");
  assert.equal(Object.getPrototypeOf(okFixed.value), Object.prototype);

  const weird = Object.create({ inherited: true });
  weird.k = "v";
  const blocked = snapshotPlainData(weird);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /prototype/);
});

test("plain-snapshot ⒝: 산출물은 원본과 분리된다 -- 고정 뒤 원본을 바꿔도 따라가지 않는다", () => {
  const input = { list: ["a"], nested: { k: 1 } };
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, true, fixed.reason);
  input.list.push("b");
  input.nested.k = 999;
  assert.deepEqual(fixed.value.list, ["a"]);
  assert.equal(fixed.value.nested.k, 1);
});

test("plain-snapshot ⒞: 산출물은 깊게 얼어 있고 프로토타입은 순정이다", () => {
  const fixed = snapshotPlainData({ a: [{ b: 1 }] });
  assert.equal(fixed.ok, true, fixed.reason);
  assert.equal(Object.isFrozen(fixed.value), true);
  assert.equal(Object.isFrozen(fixed.value.a), true);
  assert.equal(Object.isFrozen(fixed.value.a[0]), true);
  assert.equal(Object.getPrototypeOf(fixed.value), Object.prototype);
  assert.equal(Object.getPrototypeOf(fixed.value.a), Array.prototype);
});

// HYK-447 1R 계약 변경: 6R은 Array 서브클래스를 받아 "재정의가 남지 않은
// 순정 배열"로 복사했다(그때의 시험이 그 사실을 쟀다). 이제는 받지 않는다 --
// 서브클래스 인스턴스는 평범한 자료가 아니고, 그 안에는 언제든 접근자·
// Symbol.species·getter를 심을 수 있다. "무엇이든 자료로 만들어 준다"를
// 그만두고 "이미 자료인 것만 받는다"로 방향을 뒤집은 결과다(⒜).
test("plain-snapshot ⒜: Array 서브클래스 인스턴스는 순정 배열로 복사되지 않고 거부된다", () => {
  class EveryBypass extends Array {
    every() {
      return true;
    }
    includes() {
      return false;
    }
  }
  const forged = new EveryBypass();
  forged.push("ok", null);
  const fixed = snapshotPlainData({ forged });
  assert.equal(fixed.ok, false);
  assert.match(
    fixed.reason,
    /Array subclass|prototype is not Array\.prototype/,
  );
});

test("plain-snapshot ⒞: '__proto__' 키는 산출물의 프로토타입을 바꾸지 못하고 평범한 own 속성이 된다", () => {
  const input = JSON.parse('{"__proto__": {"polluted": true}}');
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, true, fixed.reason);
  assert.equal(Object.getPrototypeOf(fixed.value), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(fixed.value), ["__proto__"]);
});

test("plain-snapshot 명시적 거부: Proxy는 어느 깊이에 있든 거부된다", () => {
  const proxy = new Proxy(["a"], { get: (t, p, r) => Reflect.get(t, p, r) });
  const top = snapshotPlainData(proxy);
  assert.equal(top.ok, false);
  assert.match(top.reason, /Proxy/);
  const nested = snapshotPlainData({ policy: { protectedSeats: proxy } });
  assert.equal(nested.ok, false);
  assert.match(nested.reason, /Proxy/);
});

// ★ Proxy 거부가 "또 한 형태 막기"가 아니라는 근거를 시험으로 고정한다:
// 순정 Array는 length를 줄이는 순간 그 밖의 원소가 **실제로 지워진다**
// (언어 불변식). 따라서 Array.isArray가 true이면서 자기 원소를 감출 수
// 있는 운반체는 Proxy 하나뿐이다 -- 이 시험이 그 전제를 고정한다.
test("plain-snapshot 전제: 순정 Array는 length를 위조해 원소를 숨길 수 없다(Proxy만이 그럴 수 있다)", () => {
  const hiding = ["visible", "hidden"];
  Object.defineProperty(hiding, "length", { value: 1, writable: true });
  assert.equal(hiding.length, 1);
  assert.equal(
    Object.prototype.hasOwnProperty.call(hiding, "1"),
    false,
    "length를 줄이면 원소가 실제로 지워져야 한다 -- 숨겨지는 게 아니다",
  );
  const fixed = snapshotPlainData(hiding);
  assert.equal(fixed.ok, true, fixed.reason);
  assert.deepEqual(fixed.value, ["visible"]);

  // 같은 은닉을 Proxy로 시도하면 -- 그건 거부된다.
  const proxied = new Proxy(["visible", "hidden"], {
    get: (t, p, r) => (p === "length" ? 1 : Reflect.get(t, p, r)),
  });
  assert.equal(Array.isArray(proxied), true);
  assert.equal(proxied.length, 1);
  assert.equal(proxied[1], "hidden");
  const blocked = snapshotPlainData(proxied);
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /Proxy/);
});

test("plain-snapshot 명시적 거부: 함수/심볼/BigInt는 평범한 자료가 아니다", () => {
  for (const bad of [() => 1, Symbol("s"), 1n]) {
    const fixed = snapshotPlainData({ bad });
    assert.equal(fixed.ok, false, String(bad));
    assert.match(fixed.reason, /is not plain data/);
  }
});

test("plain-snapshot: 순환 참조와 과도한 깊이는 예산으로 접힌다(무한 순회 없음)", () => {
  const cyclic = { name: "root" };
  cyclic.self = cyclic;
  const fixed = snapshotPlainData(cyclic, { maxNodes: 64 });
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /node budget|nests deeper/);

  const deep = snapshotPlainData(
    { a: { b: { c: { d: 1 } } } },
    { maxDepth: 2 },
  );
  assert.equal(deep.ok, false);
  assert.match(deep.reason, /nests deeper/);
});

test("plain-snapshot: 던지는 getter는 애초에 불리지 않는다 -- 예외 없이 거부 사유로 돌아온다", () => {
  let called = false;
  const input = {
    get boom() {
      called = true;
      throw new Error("nope");
    },
  };
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /accessor property \('boom'\)/);
  assert.equal(called, false);
});

// ⚠️ 경계가 **못 잡는 것**을 시험으로 못박아 둔다(정직 한계): 순정 객체로
// 배열을 흉내 낸 값은 이미 "그 평범한 자료 자체"이므로 여기서는 통과한다.
// 그것을 "보호 목록이 비어 있다"로 읽지 않는 책임은 소비자 스키마에 있다
// (teardown-core.mjs의 isValidPolicyShape -- 그쪽 시험이 그 자리를 잰다).
test("plain-snapshot 정직 한계: 배열을 흉내 낸 순정 객체는 경계가 구별하지 못한다(통과) -- 거부는 소비자 스키마 몫이다", () => {
  const fixed = snapshotPlainData({ 0: "hidden", length: 0 });
  assert.equal(fixed.ok, true, fixed.reason);
  assert.equal(Array.isArray(fixed.value), false);
  assert.equal(fixed.value.length, 0);
  assert.equal(fixed.value["0"], "hidden");
});

// ---------------------------------------------------------------------------
// HYK-447 2R -- ★검토 1R P1: 「보이지 않는 own 속성이 조용히 사라진다」.
// 1R 의 판별은 값의 **종류**에는 미쳤지만 속성의 **가시성**에는 미치지
// 못했다(`Object.keys` 는 열거 가능한 own 문자열 키만 돈다). 사라진 필드는
// 「없는 필드」와 구별되지 않으므로, 안전장치를 **숨기는 것만으로** 파괴가
// 허가됐다. 아래 시험들은 그 소멸이 이제 **거부**임을 고정한다.
// ⛔이 시험들은 필드 «이름»을 하나도 특별 취급하지 않는다 -- 지어낸 이름도
// 같은 사유로 거부되는 것을 함께 잰다.
// ---------------------------------------------------------------------------

function hidden(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return obj;
}

test("plain-snapshot ⒜(2R): 비열거 own 속성은 사라지지 않고 거부된다", () => {
  const fixed = snapshotPlainData(
    hidden({ visible: "data" }, "protectedTargets", ["digest-protected"]),
  );
  assert.equal(fixed.ok, false);
  assert.match(
    fixed.reason,
    /non-enumerable own property \('protectedTargets'\)/,
  );
});

test("plain-snapshot ⒜(2R): 이름은 보지 않는다 -- 계약에 없는 지어낸 비열거 필드도 똑같이 거부된다(허용 목록 아님)", () => {
  const fixed = snapshotPlainData(
    hidden({ visible: "data" }, "totallyMadeUpFieldNobodyDeclared", { a: 1 }),
  );
  assert.equal(fixed.ok, false);
  assert.match(
    fixed.reason,
    /non-enumerable own property \('totallyMadeUpFieldNobodyDeclared'\)/,
  );
});

test("plain-snapshot ⒜(2R): 비열거 getter는 「불리지 않는」 대신 사라지지 않는다 -- 거부되고, 호출도 0이다", () => {
  let calls = 0;
  const input = { visible: "data" };
  Object.defineProperty(input, "protectedTargets", {
    get() {
      calls += 1;
      return ["digest-protected"];
    },
    enumerable: false,
    configurable: true,
  });
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, false);
  // ★사유는 «숨겨졌다»가 맞다 -- 접근자였다는 사실보다 사라진다는 사실이
  // 이 입력의 위험(검토 1R P1)이다.
  assert.match(
    fixed.reason,
    /non-enumerable own property \('protectedTargets'\)/,
  );
  assert.equal(calls, 0);
});

test("plain-snapshot ⒜(2R): 심볼 키 own 속성도 조용히 버리지 않고 거부한다", () => {
  const marker = Symbol("policy");
  const input = { visible: "data" };
  input[marker] = ["digest-protected"];
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /symbol-keyed own property \(Symbol\(policy\)\)/);
});

test("plain-snapshot ⒜(2R): 배열의 «원소가 아닌» own 속성(숨긴 것·심볼)도 거부된다", () => {
  const withHidden = hidden(["a"], "hiddenExtra", "digest-protected");
  const r1 = snapshotPlainData(withHidden);
  assert.equal(r1.ok, false);
  assert.match(
    r1.reason,
    /own property that is not an element \(hiddenExtra\)/,
  );

  const withSymbol = ["a"];
  withSymbol[Symbol("k")] = "hidden";
  const r2 = snapshotPlainData(withSymbol);
  assert.equal(r2.ok, false);
  assert.match(
    r2.reason,
    /own property that is not an element \(Symbol\(k\)\)/,
  );

  const withNonEnumerableElement = ["a", "b"];
  Object.defineProperty(withNonEnumerableElement, 1, {
    value: "b",
    enumerable: false,
    configurable: true,
  });
  const r3 = snapshotPlainData(withNonEnumerableElement);
  assert.equal(r3.ok, false);
  assert.match(r3.reason, /non-enumerable own property \('1'\)/);
});

test("plain-snapshot ⒜(2R) 회귀: 평범한 배열·객체는 그대로 통과한다(배열의 length는 «숨겨진 필드»가 아니다)", () => {
  const fixed = snapshotPlainData({ list: ["a", "b"], nested: { k: 1 } });
  assert.equal(fixed.ok, true, fixed.reason);
  assert.deepEqual(fixed.value.list, ["a", "b"]);
  assert.equal(fixed.value.nested.k, 1);
  // 얼린 산출물을 다시 고정해도(소비 경로에서 실제로 일어난다) 통과한다.
  const again = snapshotPlainData(fixed.value);
  assert.equal(again.ok, true, again.reason);
  assert.deepEqual(again.value.list, ["a", "b"]);
});

test("plain-snapshot: 원시값/undefined/null은 그대로 통과한다", () => {
  for (const v of ["s", 0, -1.5, true, false, null, undefined]) {
    const fixed = snapshotPlainData(v);
    assert.equal(fixed.ok, true);
    assert.equal(fixed.value, v);
  }
});
