// HYK-292 (coder-task.md §3-1 요건 2, 3) -- docs-budget-config-adapter.mjs
// 계약 시험. concurrency-cap-adapter.test.mjs와 같은 형태(mkdtemp 픽스처,
// fail-closed 전수 스윕, throw 0).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  readDocsBudgetConfig,
  DOCS_BUDGET_CONFIG_REASON,
  DOCS_BUDGET_CONFIG_SCHEMA_VERSION,
} from "./docs-budget-config-adapter.mjs";

function withTempConfigFile(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), "nc-docs-budget-config-"));
  const filePath = join(dir, "docs-budget-config.json");
  try {
    if (content !== undefined) writeFileSync(filePath, content, "utf8");
    return fn(filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const WELL_FORMED = {
  schema_version: DOCS_BUDGET_CONFIG_SCHEMA_VERSION,
  status_budget_bytes: 65536,
  orch_boot_budget_bytes: 98304,
  pm_output_budget_bytes: null,
};

test("readDocsBudgetConfig: well-formed file -> ok:true with exact values (committed approved numbers)", () => {
  withTempConfigFile(JSON.stringify(WELL_FORMED), (configPath) => {
    const result = readDocsBudgetConfig({ configPath });
    assert.equal(result.ok, true);
    assert.equal(result.statusBudgetBytes, 65536);
    assert.equal(result.orchBootBudgetBytes, 98304);
    assert.equal(result.pmOutputBudgetBytes, null);
    assert.equal(result.configPath, configPath);
  });
});

test("readDocsBudgetConfig: pm_output_budget_bytes may be a positive integer once approved (not forever null)", () => {
  withTempConfigFile(
    JSON.stringify({ ...WELL_FORMED, pm_output_budget_bytes: 50000 }),
    (configPath) => {
      const result = readDocsBudgetConfig({ configPath });
      assert.equal(result.ok, true);
      assert.equal(result.pmOutputBudgetBytes, 50000);
    },
  );
});

test("readDocsBudgetConfig reacts to the file's actual content -- writing a different value changes the return value", () => {
  withTempConfigFile(JSON.stringify(WELL_FORMED), (configPath) => {
    const before = readDocsBudgetConfig({ configPath });
    assert.equal(before.statusBudgetBytes, 65536);

    writeFileSync(
      configPath,
      JSON.stringify({ ...WELL_FORMED, status_budget_bytes: 1024 }),
      "utf8",
    );
    const after = readDocsBudgetConfig({ configPath });
    assert.equal(after.ok, true);
    assert.equal(
      after.statusBudgetBytes,
      1024,
      "changing the committed file must change the returned value",
    );
  });
});

test("readDocsBudgetConfig: file does not exist -> ok:false, FILE_UNREADABLE, no fallback number", () => {
  withTempConfigFile(undefined, (configPath) => {
    const result = readDocsBudgetConfig({ configPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.FILE_UNREADABLE);
    assert.equal(result.statusBudgetBytes, undefined);
  });
});

test("readDocsBudgetConfig: readFn throws -> ok:false, FILE_UNREADABLE, no throw escapes", () => {
  const result = readDocsBudgetConfig({
    configPath: "/does/not/matter",
    readFn: () => {
      throw new Error("simulated read failure");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.FILE_UNREADABLE);
});

test("readDocsBudgetConfig: malformed JSON -> ok:false, MALFORMED_JSON", () => {
  withTempConfigFile("{ this is not json", (configPath) => {
    const result = readDocsBudgetConfig({ configPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.MALFORMED_JSON);
  });
});

const SCHEMA_VIOLATIONS = [
  {
    label: "missing schema_version",
    body: { ...WELL_FORMED, schema_version: undefined },
  },
  {
    label: "wrong schema_version string",
    body: { ...WELL_FORMED, schema_version: "docs-budget/v2" },
  },
  {
    label: "schema_version is not a string",
    body: { ...WELL_FORMED, schema_version: 1 },
  },
  {
    label: "missing status_budget_bytes",
    body: { ...WELL_FORMED, status_budget_bytes: undefined },
  },
  {
    label: "status_budget_bytes is a string",
    body: { ...WELL_FORMED, status_budget_bytes: "65536" },
  },
  {
    label: "status_budget_bytes is zero",
    body: { ...WELL_FORMED, status_budget_bytes: 0 },
  },
  {
    label: "status_budget_bytes is negative",
    body: { ...WELL_FORMED, status_budget_bytes: -1 },
  },
  {
    label: "status_budget_bytes is not an integer",
    body: { ...WELL_FORMED, status_budget_bytes: 65536.5 },
  },
  {
    label: "missing orch_boot_budget_bytes",
    body: { ...WELL_FORMED, orch_boot_budget_bytes: undefined },
  },
  {
    label: "orch_boot_budget_bytes is zero",
    body: { ...WELL_FORMED, orch_boot_budget_bytes: 0 },
  },
  {
    label: "orch_boot_budget_bytes is negative",
    body: { ...WELL_FORMED, orch_boot_budget_bytes: -1 },
  },
  {
    label: "pm_output_budget_bytes is a string",
    body: { ...WELL_FORMED, pm_output_budget_bytes: "50000" },
  },
  {
    label: "pm_output_budget_bytes is zero",
    body: { ...WELL_FORMED, pm_output_budget_bytes: 0 },
  },
  {
    label: "pm_output_budget_bytes is negative",
    body: { ...WELL_FORMED, pm_output_budget_bytes: -1 },
  },
  {
    label: "top-level is an array",
    body: [DOCS_BUDGET_CONFIG_SCHEMA_VERSION, 65536],
  },
  { label: "top-level is null", body: null },
];
for (const { label, body } of SCHEMA_VIOLATIONS) {
  test(`readDocsBudgetConfig: schema violation (${label}) -> ok:false, SCHEMA_MISMATCH (denominator: ${SCHEMA_VIOLATIONS.length})`, () => {
    withTempConfigFile(JSON.stringify(body), (configPath) => {
      const result = readDocsBudgetConfig({ configPath });
      assert.equal(result.ok, false);
      assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.SCHEMA_MISMATCH);
    });
  });
}

test("false-positive count is 0 across all schema-violation fixtures above (every one produced ok:false)", () => {
  const falsePositives = SCHEMA_VIOLATIONS.filter(({ body }) => {
    let result;
    withTempConfigFile(JSON.stringify(body), (configPath) => {
      result = readDocsBudgetConfig({ configPath });
    });
    return result.ok !== false;
  });
  assert.deepEqual(
    falsePositives.map((f) => f.label),
    [],
    `denominator=${SCHEMA_VIOLATIONS.length}, false positives=${falsePositives.length}`,
  );
});

for (const badArgs of [null, undefined, "x", 1, [], true]) {
  test(`fail-closed: readDocsBudgetConfig(${JSON.stringify(badArgs)}) -> INVALID_ARGUMENTS`, () => {
    const result = readDocsBudgetConfig(badArgs);
    assert.equal(result.ok, false);
    assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.INVALID_ARGUMENTS);
  });
}

for (const badPath of [null, undefined, "", 1, [], {}]) {
  test(`fail-closed: configPath=${JSON.stringify(badPath)} -> INVALID_ARGUMENTS`, () => {
    const result = readDocsBudgetConfig({ configPath: badPath });
    assert.equal(result.ok, false);
    assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.INVALID_ARGUMENTS);
  });
}

test("fail-closed: readFn provided but not a function -> INVALID_ARGUMENTS, real fs is never touched", () => {
  const result = readDocsBudgetConfig({
    configPath: "/does/not/matter",
    readFn: "not-a-function",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, DOCS_BUDGET_CONFIG_REASON.INVALID_ARGUMENTS);
});

test("readDocsBudgetConfig never throws across every fixture above (adversarial sweep)", () => {
  const attempts = [
    () => readDocsBudgetConfig(null),
    () => readDocsBudgetConfig({}),
    () => readDocsBudgetConfig({ configPath: "" }),
    () =>
      readDocsBudgetConfig({
        configPath: "/nonexistent/path/docs-budget-config.json",
      }),
    () =>
      readDocsBudgetConfig({
        configPath: "/x",
        readFn: () => {
          throw new Error("boom");
        },
      }),
    () =>
      readDocsBudgetConfig({ configPath: "/x", readFn: () => "{ not json" }),
  ];
  for (const attempt of attempts) {
    assert.doesNotThrow(attempt);
  }
});

test("the committed scripts/check/docs-budget-config.json itself satisfies the schema and carries the approved numbers", () => {
  const configPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "docs-budget-config.json",
  );
  const result = readDocsBudgetConfig({ configPath });
  assert.equal(result.ok, true);
  assert.equal(result.statusBudgetBytes, 65536);
  assert.equal(result.orchBootBudgetBytes, 98304);
  assert.equal(result.pmOutputBudgetBytes, null);
});
