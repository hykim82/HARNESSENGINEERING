// HYK-241 §2 조각3 §3-1: «지워도 초록» 금지 -- 4칸 검문 지점을 지우거나
// 무력화한 변이본에서 시험이 실제로 실패(RED)함을 증명한다.
//
// ⛔합성 표적에서만 변이한다 -- 현재 작업트리 소스를 문자열 치환해 임시
// 사본을 만들고, 그 사본만 실행한다. 원본 파일은 절대 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(HERE, "gate1-four-cells-core.mjs");
const CHECK_PATH = join(HERE, "gate1-four-cells-check.mjs");

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function withTempDir(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "gate1-four-cells-core.mjs": readFileSync(CORE_PATH, "utf8"),
    "gate1-four-cells-check.mjs": readFileSync(CHECK_PATH, "utf8"),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

function runCli(scriptsCheckDir, args) {
  try {
    const stdout = execFileSync(
      "node",
      [join(scriptsCheckDir, "gate1-four-cells-check.mjs"), ...args],
      { encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

// A proposal document with ONE candidate missing 질문2 entirely -- must RED.
function writeIncompleteProposal(dir) {
  const filePath = join(dir, "gate1.md");
  writeFileSync(
    filePath,
    [
      "## 후보: 결손안",
      "질문1: 북극성에 심각함",
      "사분면: 2",
      "Linear: HYK-9600",
    ].join("\n"),
    "utf8",
  );
  return filePath;
}

// ---------------------------------------------------------------------------
// mutation ⓐ (필수): 질문2 check removed from checkCandidateCells -> a
// candidate missing 질문2 entirely is no longer flagged -> silently PASSes.
// ---------------------------------------------------------------------------

test("mutation ⓐ (필수): 질문2 check removed from checkCandidateCells -> a candidate missing 질문2 silently PASSes -> RED", () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target =
    '  const q2 = body.match(Q2_RE);\n  if (!q2) missingCells.push("질문2");\n\n';
  assertExactlyOneMatch(src, target, "질문2 missing-check block");
  const mutated = src.replace(target, "");

  withTempDir("hyk241-gate1-mut-a-", (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "gate1-four-cells-core.mjs": mutated,
    });
    const fixtureDir = mkdtempSync(join(tmpdir(), "hyk241-gate1-mut-a-fix-"));
    try {
      const filePath = writeIncompleteProposal(fixtureDir);
      const r = runCli(scriptsCheckDir, [filePath]);
      assert.equal(
        r.status,
        0,
        "RED-setup: without the 질문2 check, a candidate missing 질문2 entirely wrongly PASSes",
      );
      assert.match(r.stdout, /PASS/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mutation ⓑ (필수): the zero-candidates fail-closed branch replaced with a
// silent-pass -- an empty/malformed document (no '## 후보:' heading at all)
// wrongly PASSes instead of being flagged as unjudgeable.
// ---------------------------------------------------------------------------

test("mutation ⓑ (필수): zero-candidates fail-closed branch flipped to ok:true -> an empty proposal document wrongly PASSes -> RED", () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target =
    "  if (blocks.length === 0) {\n    return {\n      ok: false,\n";
  assertExactlyOneMatch(src, target, "zero-candidates fail-closed branch");
  const mutated = src.replace(
    target,
    "  if (blocks.length === 0) {\n    return {\n      ok: true,\n",
  );

  withTempDir("hyk241-gate1-mut-b-", (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "gate1-four-cells-core.mjs": mutated,
    });
    const fixtureDir = mkdtempSync(join(tmpdir(), "hyk241-gate1-mut-b-fix-"));
    try {
      const filePath = join(fixtureDir, "empty.md");
      writeFileSync(filePath, "아무 후보도 없는 빈 문서\n", "utf8");
      const r = runCli(scriptsCheckDir, [filePath]);
      assert.equal(
        r.status,
        0,
        "RED-setup: with the fail-closed branch flipped, an empty document (no candidates at all) wrongly PASSes",
      );
      assert.match(r.stdout, /PASS/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// mutation ⓒ (자유 선택): Linear cell's validation loosened to accept ANY
// non-empty value (not just an HYK-<digits> ref or a 미등재/등재 요청 note)
// -- exactly the "아무 문구나 있으면 통과" shape §2 조각3 forbids.
// ---------------------------------------------------------------------------

test("mutation ⓒ (자유 선택): Linear cell validation loosened to accept any non-empty text -> a nonsense placeholder wrongly satisfies it -> RED", () => {
  const src = readFileSync(CORE_PATH, "utf8");
  const target = "    if (!isIssueRef && !isUnregisteredNote) {\n";
  assertExactlyOneMatch(src, target, "Linear validation guard");
  const mutated = src.replace(target, "    if (false) {\n");

  withTempDir("hyk241-gate1-mut-c-", (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "gate1-four-cells-core.mjs": mutated,
    });
    const fixtureDir = mkdtempSync(join(tmpdir(), "hyk241-gate1-mut-c-fix-"));
    try {
      const filePath = join(fixtureDir, "gate1.md");
      writeFileSync(
        filePath,
        [
          "## 후보: 무효Linear안",
          "질문1: a",
          "질문2: b",
          "사분면: 1",
          "Linear: 나중에 정함",
        ].join("\n"),
        "utf8",
      );
      const r = runCli(scriptsCheckDir, [filePath]);
      assert.equal(
        r.status,
        0,
        "RED-setup: with the guard neutered, a nonsense Linear value ('나중에 정함') wrongly PASSes",
      );
      assert.match(r.stdout, /PASS/);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
