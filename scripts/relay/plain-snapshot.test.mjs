import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotPlainData } from "./plain-snapshot.mjs";

// HYK-431 6R -- 신뢰 경계 고정기(plain-snapshot.mjs)의 단위 계약.
// 여기서 재는 것은 세 성질뿐이다(coder-task.md §2-2 ⒜⒝⒞):
//   ⒜ 입력의 각 지점을 정확히 한 번만 읽는다
//   ⒝ 산출물은 원본과 분리된 자료다(원본이 나중에 변해도 안 따라간다)
//   ⒞ 산출물에는 흔들 수 있는 것(getter/Proxy/프로토타입 재정의)이 없다

test("plain-snapshot ⒜: 값이 호출마다 바뀌는 getter도 정확히 한 번만 읽는다", () => {
  let reads = 0;
  const input = {
    get volatile() {
      reads += 1;
      return `read-${reads}`;
    },
  };
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, true, fixed.reason);
  assert.equal(reads, 1, "getter는 정확히 한 번만 불려야 한다");
  assert.equal(fixed.value.volatile, "read-1");
  // 고정본을 몇 번을 읽어도 그 값은 더 안 변한다(원본은 계속 변할 텐데도).
  assert.equal(fixed.value.volatile, "read-1");
  assert.equal(fixed.value.volatile, "read-1");
  assert.equal(reads, 1);
});

test("plain-snapshot ⒜: 배열 원소 getter도 원소당 정확히 한 번만 읽는다", () => {
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
  assert.equal(fixed.ok, true, fixed.reason);
  assert.equal(reads, 1);
  assert.deepEqual(fixed.value.arr, ["el-1"]);
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

test("plain-snapshot ⒞: Array 서브클래스의 own 메서드 재정의는 고정본에 남지 않는다", () => {
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
  assert.equal(fixed.ok, true, fixed.reason);
  const out = fixed.value.forged;
  assert.equal(Object.getPrototypeOf(out), Array.prototype);
  // 고정본의 every/includes는 순정 것이다 -- 재정의는 사라졌다.
  assert.equal(
    out.every((el) => typeof el === "string"),
    false,
  );
  assert.equal(out.includes("ok"), true);
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

test("plain-snapshot: 던지는 getter는 예외가 아니라 실패 사유로 돌아온다", () => {
  const input = {
    get boom() {
      throw new Error("nope");
    },
  };
  const fixed = snapshotPlainData(input);
  assert.equal(fixed.ok, false);
  assert.match(fixed.reason, /reading the input threw \(nope\)/);
});

test("plain-snapshot: 원시값/undefined/null은 그대로 통과한다", () => {
  for (const v of ["s", 0, -1.5, true, false, null, undefined]) {
    const fixed = snapshotPlainData(v);
    assert.equal(fixed.ok, true);
    assert.equal(fixed.value, v);
  }
});
