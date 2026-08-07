// HYK-193 1R (coder-task.md §2, §3, §5) -- concurrency-cap-adapter.mjs 계약
// 시험.
//
// 이 계약이 보장하지 않는 것 (S11):
// 1. 이 시험은 실제 값 파일(`concurrency-cap.json`)이 아니라 mkdtemp에
//    합성한 사본 파일을 읽는다 -- 실제 값 파일이 이 스키마를 따르는지는
//    별도로 concurrency-cap-check.test.mjs(§4 확인 명령)와
//    quality-check(JSON 파싱) 양쪽에서 확인한다.
// 2. `readConcurrencyCap`이 반환한 `cap`이 `concurrency-core.mjs`의
//    `globalCap` 인자에 실제로 결선돼 있는지는 이 시험의 범위 밖이다
//    (live=false, 호출자 없음 -- concurrency-core.test.mjs의 "S-5
//    regression" 시험 머리 주석 참조).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readConcurrencyCap,
  CONCURRENCY_CAP_REASON,
  CONCURRENCY_CAP_SCHEMA_VERSION,
} from "./concurrency-cap-adapter.mjs";

function withTempCapFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-concurrency-cap-"));
  const filePath = join(dir, "concurrency-cap.json");
  try {
    if (content !== undefined) writeFileSync(filePath, content, "utf8");
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 양성 경로 -- 스키마가 온전한 파일은 정확한 값을 반환한다.
// ---------------------------------------------------------------------------
test("readConcurrencyCap: well-formed file -> ok:true with the exact cap value", () => {
  withTempCapFile(
    JSON.stringify({
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: 2,
    }),
    (capPath) => {
      const result = readConcurrencyCap({ capPath });
      assert.equal(result.ok, true);
      assert.equal(result.cap, 2);
      assert.equal(result.capPath, capPath);
    },
  );
});

// ---------------------------------------------------------------------------
// HYK-193 §5 -- "값을 바꿔 넣으면 판정이 따라 움직인다"를 어댑터 층에서
// 행동으로 증명한다: 같은 경로에 다른 값을 쓰면 어댑터가 그 새 값을
// 그대로 반환한다(캐시하거나 이전 값을 고수하지 않는다).
// ---------------------------------------------------------------------------
test("readConcurrencyCap reacts to the file's actual content -- writing a different value changes the return value (not merely 'code that reads a file exists')", () => {
  withTempCapFile(
    JSON.stringify({
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: 2,
    }),
    (capPath) => {
      const before = readConcurrencyCap({ capPath });
      assert.equal(before.ok, true);
      assert.equal(before.cap, 2);

      writeFileSync(
        capPath,
        JSON.stringify({
          schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
          global_hard_cap: 7,
        }),
        "utf8",
      );
      const after = readConcurrencyCap({ capPath });
      assert.equal(after.ok, true);
      assert.equal(
        after.cap,
        7,
        "changing the committed file's content must change what the adapter returns",
      );
    },
  );
});

test("readConcurrencyCap: global_hard_cap=0 is a structurally valid (if unusual) value -- adapter does not special-case zero", () => {
  withTempCapFile(
    JSON.stringify({
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: 0,
    }),
    (capPath) => {
      const result = readConcurrencyCap({ capPath });
      assert.equal(result.ok, true);
      assert.equal(result.cap, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// fail-closed -- 부재·읽기 실패·형식 위반·스키마 불일치 전부 실패 객체
// (⛔숫자 기본값 폴백 없음).
// ---------------------------------------------------------------------------
test("readConcurrencyCap: file does not exist -> ok:false, FILE_UNREADABLE, no fallback number", () => {
  withTempCapFile(undefined, (capPath) => {
    const result = readConcurrencyCap({ capPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, CONCURRENCY_CAP_REASON.FILE_UNREADABLE);
    assert.equal(result.cap, undefined);
  });
});

test("readConcurrencyCap: readFn throws -> ok:false, FILE_UNREADABLE, no throw escapes", () => {
  const result = readConcurrencyCap({
    capPath: "/does/not/matter",
    readFn: () => {
      throw new Error("simulated read failure");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, CONCURRENCY_CAP_REASON.FILE_UNREADABLE);
});

test("readConcurrencyCap: malformed JSON -> ok:false, MALFORMED_JSON", () => {
  withTempCapFile("{ this is not json", (capPath) => {
    const result = readConcurrencyCap({ capPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, CONCURRENCY_CAP_REASON.MALFORMED_JSON);
  });
});

const SCHEMA_VIOLATIONS = [
  {
    label: "missing schema_version",
    body: { global_hard_cap: 2 },
  },
  {
    label: "wrong schema_version string",
    body: { schema_version: "concurrency-cap/v2", global_hard_cap: 2 },
  },
  {
    label: "schema_version is not a string",
    body: { schema_version: 1, global_hard_cap: 2 },
  },
  {
    label: "missing global_hard_cap",
    body: { schema_version: CONCURRENCY_CAP_SCHEMA_VERSION },
  },
  {
    label: "global_hard_cap is a string",
    body: {
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: "2",
    },
  },
  {
    label: "global_hard_cap is negative",
    body: {
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: -1,
    },
  },
  {
    label: "global_hard_cap is not an integer",
    body: {
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: 2.5,
    },
  },
  {
    label: "global_hard_cap is NaN-producing (Infinity)",
    body: {
      schema_version: CONCURRENCY_CAP_SCHEMA_VERSION,
      global_hard_cap: Infinity,
    },
  },
  {
    label: "top-level is an array",
    body: [CONCURRENCY_CAP_SCHEMA_VERSION, 2],
  },
  {
    label: "top-level is null",
    body: null,
  },
];
for (const { label, body } of SCHEMA_VIOLATIONS) {
  test(`readConcurrencyCap: schema violation (${label}) -> ok:false, SCHEMA_MISMATCH (denominator: ${SCHEMA_VIOLATIONS.length})`, () => {
    withTempCapFile(JSON.stringify(body), (capPath) => {
      const result = readConcurrencyCap({ capPath });
      assert.equal(result.ok, false);
      assert.equal(result.reason, CONCURRENCY_CAP_REASON.SCHEMA_MISMATCH);
    });
  });
}

test("false-positive count is 0 across all schema-violation fixtures above (every one produced ok:false)", () => {
  const falsePositives = SCHEMA_VIOLATIONS.filter(({ body }) => {
    let result;
    withTempCapFile(JSON.stringify(body), (capPath) => {
      result = readConcurrencyCap({ capPath });
    });
    return result.ok !== false;
  });
  assert.deepEqual(
    falsePositives.map((f) => f.label),
    [],
    `denominator=${SCHEMA_VIOLATIONS.length}, false positives=${falsePositives.length}`,
  );
});

// ---------------------------------------------------------------------------
// fail-closed / INVALID_ARGUMENTS -- 인자 자체가 이상한 경우.
// ---------------------------------------------------------------------------
for (const badArgs of [null, undefined, "x", 1, [], true]) {
  test(`fail-closed: readConcurrencyCap(${JSON.stringify(badArgs)}) -> INVALID_ARGUMENTS`, () => {
    const result = readConcurrencyCap(badArgs);
    assert.equal(result.ok, false);
    assert.equal(result.reason, CONCURRENCY_CAP_REASON.INVALID_ARGUMENTS);
  });
}

for (const badPath of [null, undefined, "", 1, [], {}]) {
  test(`fail-closed: capPath=${JSON.stringify(badPath)} -> INVALID_ARGUMENTS`, () => {
    const result = readConcurrencyCap({ capPath: badPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, CONCURRENCY_CAP_REASON.INVALID_ARGUMENTS);
  });
}

test("fail-closed: readFn provided but not a function -> INVALID_ARGUMENTS, real fs is never touched", () => {
  const result = readConcurrencyCap({
    capPath: "/does/not/matter",
    readFn: "not-a-function",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, CONCURRENCY_CAP_REASON.INVALID_ARGUMENTS);
});

// ---------------------------------------------------------------------------
// throw 0 -- 이 어댑터의 어떤 공개 경로도 예외를 던지지 않는다
// (approval-authority-adapter.mjs 선례와 같은 원칙).
// ---------------------------------------------------------------------------
test("readConcurrencyCap never throws across every fixture above (adversarial sweep)", () => {
  const attempts = [
    () => readConcurrencyCap(null),
    () => readConcurrencyCap({}),
    () => readConcurrencyCap({ capPath: "" }),
    () =>
      readConcurrencyCap({
        capPath: "/nonexistent/path/concurrency-cap.json",
      }),
    () =>
      readConcurrencyCap({
        capPath: "/x",
        readFn: () => {
          throw new Error("boom");
        },
      }),
    () =>
      readConcurrencyCap({
        capPath: "/x",
        readFn: () => "{ not json",
      }),
  ];
  for (const attempt of attempts) {
    assert.doesNotThrow(attempt);
  }
});
