// HYK-241 §2 조각1 §3-1: «지워도 초록» 금지 -- task 파일 보존 지점을 지우거나
// 무력화한 변이본에서 시험이 실제로 실패(RED)함을 증명한다.
//
// ⛔합성 표적에서만 변이한다 -- envelope-archive-mutation.test.mjs와 동일한
// 기법(문자열 치환한 임시 사본만 실행, 원본 파일은 절대 건드리지 않음).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENVELOPE_ARCHIVE_PATH = join(HERE, "envelope-archive.mjs");
const RELAY_HANDSHAKE_PATH = join(HERE, "relay-handshake.mjs");
const REJECT_STREAK_PATH = join(HERE, "reject-streak.mjs");
const TIME_AUTHORITY_PATH = join(HERE, "time-authority.mjs");

function tmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function withTempDir(prefix, fn) {
  const dir = tmpDir(prefix);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertExactlyOneMatch(src, target, label) {
  const count = src.split(target).length - 1;
  assert.equal(
    count,
    1,
    `mutation target "${label}" must appear exactly once in the current working-tree source (found ${count})`,
  );
}

function stageScriptsCheckDir(rootDir, overrides) {
  const scriptsCheckDir = join(rootDir, "scripts", "check");
  mkdirSync(scriptsCheckDir, { recursive: true });
  const files = {
    "relay-handshake.mjs": readFileSync(RELAY_HANDSHAKE_PATH, "utf8"),
    "reject-streak.mjs": readFileSync(REJECT_STREAK_PATH, "utf8"),
    "envelope-archive.mjs": readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8"),
    "time-authority.mjs": readFileSync(TIME_AUTHORITY_PATH, "utf8"),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(scriptsCheckDir, name), content, "utf8");
  }
  return scriptsCheckDir;
}

function writeFixture(dir, role, taskId, droppedAt, doneAt, taskBody = "") {
  writeFileSync(
    join(dir, `${role}-task.md`),
    `task_id: ${taskId}\ndropped_at: ${droppedAt}\n${taskBody}`,
    "utf8",
  );
  writeFileSync(
    join(dir, `${role}.md`),
    `task_id: ${taskId}\n\n>>> DONE: ${role.toUpperCase()} @ ${doneAt}\n`,
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// mutation ⓐ (필수): the autoArchiveRoundTaskFile call site removed from
// checkRelayHandshake -> the handshake still passes, but the round's TASK
// TEXT is never preserved -- the §1 실사고(지시서가 사라진다) 그대로 재발.
// ---------------------------------------------------------------------------

test("mutation ⓐ (필수): autoArchiveRoundTaskFile call removed from checkRelayHandshake -> handshake still passes but no task-round text survives -> RED", async () => {
  const src = readFileSync(RELAY_HANDSHAKE_PATH, "utf8");
  const target =
    "  autoArchiveRoundTaskFile({ role, taskContent, harnessDir });\n";
  assertExactlyOneMatch(src, target, "autoArchiveRoundTaskFile call site");
  const mutated = src.replace(target, "");

  await withTempDir("hyk241-task-mut-a-", async (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "relay-handshake.mjs": mutated,
    });
    const harnessDir = join(dir, "harness-fixture");
    mkdirSync(harnessDir, { recursive: true });
    writeFixture(
      harnessDir,
      "coder",
      "HYK-9910",
      "2026-08-13 06:00 KST",
      "2026-08-13 06:10 KST",
      "이번 라운드의 지시문 원본\n",
    );

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(
      result.ok,
      true,
      "the handshake decision itself must be untouched by this mutation",
    );

    let taskArchiveFiles;
    try {
      taskArchiveFiles = readdirSync(join(harnessDir, "rounds")).filter((f) =>
        f.includes("-task-"),
      );
    } catch {
      taskArchiveFiles = [];
    }
    assert.deepEqual(
      taskArchiveFiles,
      [],
      "RED: without the wiring, a confirmed round leaves the TASK instruction text unpreserved -- §1 실사고(지시서 소실) 재발",
    );
  });
});

// ---------------------------------------------------------------------------
// mutation ⓑ (필수): nextTaskArchiveFileName ignores existing files and
// always returns round 1 -> two genuinely distinct rounds' task files land
// on the SAME filename -> the second silently overwrites the first.
// ---------------------------------------------------------------------------

test("mutation ⓑ (필수): nextTaskArchiveFileName hardcoded to always return round 1 -> round 2's task text silently overwrites round 1's -> RED", async () => {
  const src = readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8");
  const target = "  return `${role}-task-r${maxRound + 1}.md`;\n";
  assertExactlyOneMatch(src, target, "nextTaskArchiveFileName return line");
  const mutated = src.replace(target, "  return `${role}-task-r1.md`;\n");

  await withTempDir("hyk241-task-mut-b-", async (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "envelope-archive.mjs": mutated,
    });
    const harnessDir = join(dir, "harness-fixture");
    mkdirSync(harnessDir, { recursive: true });

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );

    writeFixture(
      harnessDir,
      "coder",
      "HYK-9911",
      "2026-08-13 06:00 KST",
      "2026-08-13 06:10 KST",
      "라운드1 지시문(원본)\n",
    );
    const first = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(first.ok, true);

    writeFixture(
      harnessDir,
      "coder",
      "HYK-9911",
      "2026-08-13 07:00 KST",
      "2026-08-13 07:10 KST",
      "라운드2 지시문(새 것)\n",
    );
    const second = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(second.ok, true);

    const taskArchiveFiles = readdirSync(join(harnessDir, "rounds")).filter(
      (f) => f.includes("-task-"),
    );
    assert.deepEqual(
      taskArchiveFiles,
      ["coder-task-r1.md"],
      "RED-setup: only one file exists because the mutant always names round 1",
    );
    const survivor = readFileSync(
      join(harnessDir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    assert.doesNotMatch(
      survivor,
      /라운드1 지시문/,
      "RED: round 1's task text is gone -- round 2's task text silently overwrote it",
    );
  });
});

// ---------------------------------------------------------------------------
// mutation ⓒ (자유 선택): archiveRoundTaskFile keeps the filename scheme
// correct but writes empty content instead of the round's actual task text.
// ---------------------------------------------------------------------------

test("mutation ⓒ (자유 선택): archiveRoundTaskFile writes a blank body instead of the round's verbatim task text -> archive file exists but is empty -> RED", async () => {
  const src = readFileSync(ENVELOPE_ARCHIVE_PATH, "utf8");
  const target = '    writeFileFn(destPath, header + taskContent, "utf8");\n';
  assertExactlyOneMatch(src, target, "archiveRoundTaskFile write call");
  const mutated = src.replace(
    target,
    '    writeFileFn(destPath, header, "utf8");\n',
  );

  await withTempDir("hyk241-task-mut-c-", async (dir) => {
    const scriptsCheckDir = stageScriptsCheckDir(dir, {
      "envelope-archive.mjs": mutated,
    });
    const harnessDir = join(dir, "harness-fixture");
    mkdirSync(harnessDir, { recursive: true });
    writeFixture(
      harnessDir,
      "coder",
      "HYK-9912",
      "2026-08-13 06:00 KST",
      "2026-08-13 06:10 KST",
      "지시문에 실려 있는 구체적 세부사항\n",
    );

    const mod = await import(
      `file://${join(scriptsCheckDir, "relay-handshake.mjs")}?t=${Date.now()}`
    );
    const result = mod.checkRelayHandshake({ role: "coder", harnessDir });
    assert.equal(result.ok, true);

    const taskArchiveFiles = readdirSync(join(harnessDir, "rounds")).filter(
      (f) => f.includes("-task-"),
    );
    assert.deepEqual(
      taskArchiveFiles,
      ["coder-task-r1.md"],
      "RED-setup: the file DOES exist -- an existence-only check would wrongly pass this mutant",
    );
    const archived = readFileSync(
      join(harnessDir, "rounds", "coder-task-r1.md"),
      "utf8",
    );
    assert.doesNotMatch(
      archived,
      /지시문에 실려 있는 구체적 세부사항/,
      "RED: the archive file exists but its content is not the round's actual task text",
    );
  });
});
