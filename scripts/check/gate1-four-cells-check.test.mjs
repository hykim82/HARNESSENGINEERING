import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT_PATH = fileURLToPath(
  new URL("./gate1-four-cells-check.mjs", import.meta.url),
);

function withFixtureDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "gate1-four-cells-check-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runCli(args) {
  try {
    const stdout = execFileSync("node", [SCRIPT_PATH, ...args], {
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

test("no file argument -> usage error, exit 1", () => {
  const r = runCli([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});

test("file does not exist -> exit 1, distinct reason", () => {
  const r = runCli(["/does/not/exist/gate1.md"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /file not found/);
});

test("proposal missing S16 four cells (질문2 없음) -> RED, exit 1, names the candidate and the missing cell", () => {
  withFixtureDir((dir) => {
    const filePath = join(dir, "gate1.md");
    writeFileSync(
      filePath,
      [
        "## 후보: 결손안",
        "질문1: 북극성에 심각함",
        "사분면: 2",
        "Linear: HYK-500",
      ].join("\n"),
      "utf8",
    );
    const r = runCli([filePath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /결손안/);
    assert.match(r.stderr, /질문2/);
    assert.match(r.stderr, /RED/);
  });
});

test("proposal with all candidates complete -> PASS, exit 0", () => {
  withFixtureDir((dir) => {
    const filePath = join(dir, "gate1.md");
    writeFileSync(
      filePath,
      [
        "## 후보: 완비안",
        "질문1: a",
        "질문2: b",
        "사분면: 1",
        "Linear: HYK-501",
      ].join("\n"),
      "utf8",
    );
    const r = runCli([filePath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /PASS/);
  });
});

test("empty document (no '## 후보:' heading) -> RED, exit 1 (fail-closed, never silently passes)", () => {
  withFixtureDir((dir) => {
    const filePath = join(dir, "empty.md");
    writeFileSync(filePath, "아무 내용도 없음\n", "utf8");
    const r = runCli([filePath]);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /하나도 찾지 못함/);
  });
});

test("미루기 후보에 Linear 미등재 문구가 있으면 PASS (등재 요청 문구도 허용)", () => {
  withFixtureDir((dir) => {
    const filePath = join(dir, "gate1.md");
    writeFileSync(
      filePath,
      [
        "## 후보: 미루기안",
        "질문1: a",
        "질문2: b",
        "사분면: 4",
        "Linear: 미등재 · 등재 요청",
      ].join("\n"),
      "utf8",
    );
    const r = runCli([filePath]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
