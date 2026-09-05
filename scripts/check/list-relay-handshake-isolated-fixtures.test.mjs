// HYK-430 4R -- list-relay-handshake-isolated-fixtures.mjs 자체의
// 시험. 정확한 개수(69/34/33)는 저장소가 자라면서 바뀔 수 있으므로
// 그 숫자 자체를 고정하지 않는다 -- 대신 구조적 불변식(부분집합
// 관계·정렬·중복 없음·현재 저장소에서 0이 아님)을 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findRelayHandshakeReferencingTests,
  findIsolatedCopyTests,
  findFallbackExercisingTests,
} from "./list-relay-handshake-isolated-fixtures.mjs";

test("findFallbackExercisingTests는 findIsolatedCopyTests의 부분집합이다", () => {
  const isolatedCopies = new Set(findIsolatedCopyTests());
  const fallback = findFallbackExercisingTests();
  for (const f of fallback) {
    assert.ok(
      isolatedCopies.has(f),
      `${f}는 fallback 집합에 있지만 isolatedCopy 집합에는 없다 -- 부분집합 불변식 위반`,
    );
  }
});

test("findIsolatedCopyTests는 findRelayHandshakeReferencingTests의 부분집합이다", () => {
  const referencing = new Set(findRelayHandshakeReferencingTests());
  const isolatedCopies = findIsolatedCopyTests();
  for (const f of isolatedCopies) {
    assert.ok(
      referencing.has(f),
      `${f}는 isolatedCopy 집합에 있지만 referencing 집합에는 없다 -- 부분집합 불변식 위반`,
    );
  }
});

test("이 저장소에는 실제로 격리 복사 시험이 존재한다(0이면 정의 자체가 깨진 것)", () => {
  const isolatedCopies = findIsolatedCopyTests();
  assert.ok(
    isolatedCopies.length > 0,
    "0건이면 grep 정의가 이 저장소의 실제 픽스처를 못 잡고 있다는 뜻",
  );
});

test("이 시험 자신(list-relay-handshake-isolated-fixtures.test.mjs)은 어느 집합에도 속하지 않는다(문자열 리터럴 언급이 없어야 자기지시 오염이 없다)", () => {
  const referencing = findRelayHandshakeReferencingTests();
  assert.ok(
    !referencing.includes(
      "scripts/check/list-relay-handshake-isolated-fixtures.test.mjs",
    ),
  );
});

test("결과 목록은 정렬돼 있고 중복이 없다(세 함수 전부)", () => {
  for (const fn of [
    findRelayHandshakeReferencingTests,
    findIsolatedCopyTests,
    findFallbackExercisingTests,
  ]) {
    const files = fn();
    const sorted = [...files].sort();
    assert.deepEqual(files, sorted, `${fn.name} 결과가 정렬돼 있지 않다`);
    assert.equal(
      new Set(files).size,
      files.length,
      `${fn.name} 결과에 중복이 있다`,
    );
  }
});

// 되돌림 변이 -- isolatedCopy 판정에서 mkdtempSync 동시-존재 조건을
// 빼면(파일명 문자열 매치만 남기면) 순수 정적 소비자 파일까지 섞여
// 결과가 훨씬 커진다는 것으로, 이 조건이 실제로 걸러내는 역할을
// 한다는 것을 고정한다.
test("되돌림 변이: mkdtempSync 동반 조건 없이 파일명 문자열만으로 판정하면(격리 복사와 무관한 정적 소비자도 섞임) 훨씬 많이 잡힌다 -- mkdtempSync 조건이 실제로 필터링 효과가 있다는 증거", () => {
  const withCondition = findIsolatedCopyTests().length;
  const withoutCondition = findRelayHandshakeReferencingTests().length;
  assert.ok(
    withoutCondition > withCondition,
    `mkdtempSync 동반 조건이 실제로 걸러내는 게 있어야 한다: with=${withCondition} without=${withoutCondition}`,
  );
});
