import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// HYK-431 4R §2-3 -- 목록 무결성 시험. 이 시험은 "목록의 내용이 진실"임을
// 보증하지 않는다(수기 판독 결과의 재현은 불가능하다) -- 오직 "목록
// 자체가 형식을 지키고, 중복 id로 항목을 잃어버리지 않는다"만 본다.

const jsonPath = fileURLToPath(
  new URL("./hyk436-input-method-surface.json", import.meta.url),
);
const doc = JSON.parse(readFileSync(jsonPath, "utf8"));

const VALID_CONFIDENCE = new Set(["확실", "추론", "미확인"]);
const VALID_STATUS = new Set(["fixed", "not_fixed", "not_fixed_out_of_scope"]);

test("hyk436 표면 목록: 최상위 형식(schemaVersion/findings 배열)", () => {
  assert.equal(doc.schemaVersion, 1);
  assert.ok(Array.isArray(doc.findings));
  assert.ok(doc.findings.length > 0);
});

test("hyk436 표면 목록: id는 문자열이고 저장소 전체에서 중복이 없다", () => {
  const ids = doc.findings.map((f) => f.id);
  for (const id of ids) {
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("hyk436 표면 목록: 각 항목이 file/confidence/status/reasoning을 갖추고 값이 선언된 어휘 안에 있다", () => {
  for (const f of doc.findings) {
    assert.equal(typeof f.file, "string");
    assert.ok(f.file.length > 0);
    assert.ok(
      VALID_CONFIDENCE.has(f.confidence),
      `${f.id}: confidence "${f.confidence}"는 선언된 3등급(확실/추론/미확인) 밖`,
    );
    assert.ok(
      VALID_STATUS.has(f.status),
      `${f.id}: status "${f.status}"는 선언된 어휘 밖`,
    );
    assert.equal(typeof f.reasoning, "string");
    assert.ok(f.reasoning.length > 0);
  }
});

test("hyk436 표면 목록: scripts/check/ 항목은 전부 not_fixed_out_of_scope이다(§0 절대 경계 -- 다른 레인 소유는 손대지 않는다)", () => {
  const checkFindings = doc.findings.filter((f) =>
    f.file.startsWith("scripts/check/"),
  );
  assert.ok(
    checkFindings.length > 0,
    "scripts/check/ 항목이 최소 1건은 목록에 있어야 한다(전수 열거는 저장소 전체 대상)",
  );
  for (const f of checkFindings) {
    assert.equal(
      f.status,
      "not_fixed_out_of_scope",
      `${f.id}: scripts/check/ 항목인데 status가 not_fixed_out_of_scope가 아니다`,
    );
  }
});

test("hyk436 표면 목록: status가 fixed인 항목은 전부 scripts/relay/ 안이다(§0 절대 경계 -- 수리는 scripts/relay/로만)", () => {
  const fixed = doc.findings.filter((f) => f.status === "fixed");
  assert.ok(fixed.length > 0);
  for (const f of fixed) {
    assert.ok(
      f.file.startsWith("scripts/relay/"),
      `${f.id}: status가 fixed인데 파일이 scripts/relay/ 밖(${f.file})`,
    );
    assert.ok(
      !f.file.startsWith("scripts/check/"),
      `${f.id}: scripts/check/ 파일인데 status가 fixed -- 절대 경계 위반`,
    );
  }
});
